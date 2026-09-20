#!/usr/bin/env python3
# The local recognizer's reference server: a loopback HTTP/1.1 wrapper around a
# rented speech model.
#
# WHAT IS RENTED AND WHAT IS OURS. The recognizer library, the model weights and
# the converter are rented and none of them is in this repository: the runtime
# directory named on the command line holds them, built by an optional install
# step. What is ours is this wrapper and the client that posts to it.
#
#   python transcribe-server.py --runtime DIR --model NAME [--port N] [--warm]
#                               [--idle-s N] [--exit-on-idle] [--fake]
#                               [--read-timeout-s N]
#
# EVERY KNOB IS AN ARGUMENT AND NOTHING HERE READS THE ENVIRONMENT. A behaviour
# switch in an environment variable is forbidden outright, and every knob this
# server had was one: an operator reading the unit file could not see what the
# process would do. The unit renders the whole command line from the registry.
#
# THE CLIENT CUTS, NOT THIS SERVER. A long note decoded as one stream is what
# took a box down once, so the audio arrives here already cut into pieces of a
# bounded length. A server that also cut would give two answers to one question,
# and it could never hand back the pieces it had already finished, which is the
# whole reason the client wants them one at a time. One consequence worth
# knowing: with the cut gone, the stub backend below needs no numeric library at
# all, so the suite drives this file on a bare interpreter.
#
# Two endpoints.
#   /transcribe  the chunk as the raw body, a declared length required (411
#                without), 25 MB cap (413 over), and exactly
#                {"text", "audio_s", "decode_ms"} back. The client is written
#                against those three keys.
#   /health      whether the process answers, what is loaded, the idle clock and
#                the counters. It never touches the idle clock, so reading it
#                cannot pin the model warm.
#
# TWO WAYS TO GIVE THE MEMORY BACK, reaching different numbers.
#   * IN-PLACE UNLOAD (--idle-s N). The recognizer is dropped and the allocator's
#     arenas are trimmed. This can never reach zero, because the loaded shared
#     objects and the interpreter heap survive it: measured at 67 MB on the small
#     box this runs on, and drifting between 300 and 800 MB on a development Mac,
#     where the trim call does not exist.
#   * EXIT ON IDLE (--exit-on-idle). The process leaves, which is really zero,
#     and is only honest when something starts it again on the next request.
#
# RESIDENT IS THE DEFAULT AND IT IS A RULING, not an oversight: the memory is not
# the problem when the box is merely full, it is the problem when the box is
# short, and that happens at exactly the busy moment a voice note arrives. So the
# unit renders --warm --idle-s 0 unless a household with a smaller box asks for
# the unload and accepts the ten seconds the next note waits.
#
# LOOPBACK ONLY, UNAUTHENTICATED, STATELESS AND SHARED BY EVERY PERSON IN THE
# HOUSEHOLD, BY DESIGN. It holds nothing belonging to anybody between requests,
# so there is nothing here for a fence to protect, and one resident copy of a
# model over a gigabyte serves every door instead of one copy per person on a box
# with eight gigabytes. The socket is bound to 127.0.0.1 and the peer is checked
# as well, so the day somebody changes the bind, the check is what refuses the
# network.
#
# WHAT IS DELIBERATELY NOT HERE. A shell client, because the door's own step is
# the client and reads a structured answer rather than an exit code. A cold
# in-process fallback, because it loads the whole model inside the caller at the
# one moment the box has nothing to spare, and an unreachable server is a note
# that waits instead. A keep-warm ping, because nothing unloads under the default
# residency and under the other one a ping would defeat the unload the household
# just asked for. A socket unit, because the hub renders none.
import argparse
import gc
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

# The recognizer library is imported inside load_backend() rather than at the
# top, so --fake runs on a machine with no runtime directory, no weights and no
# numeric library at all. The real path imports it at the first load, which costs
# nothing the load did not already cost.
#
# The model NAME is not here. It is what the registry says and what the command
# line passes, because a household on a smaller box names a smaller model and a
# name compiled into this file would not be a setting.
FAKE_NAME = "fake-stub"
# What the fake backend returns for any body. Fixed, so a test can assert on it.
FAKE_TEXT = "the quick brown fox jumps over the lazy dog"
FAKE_AUDIO_S = 1.0
# The fake decode sleeps this long, which is what the spec asks for: something
# that takes measurable time so a decode is distinguishable from a no-op.
FAKE_DECODE_S = 0.05
# The fake LOAD sleeps too, for one reason: last_load_ms has to be a measured
# number, and a load that returns instantly makes it a constant zero that proves
# nothing about the timer.
FAKE_LOAD_S = 0.04
# 25 MB is far above any voice note (Telegram caps a voice message well below it)
# and far below anything that would make this single-threaded process unresponsive.
MAX_BODY = 25 * 1024 * 1024
# Belt and braces. The socket is bound to 127.0.0.1 so nothing else can arrive,
# but the peer is checked anyway: a future bind change must not silently open the
# recognizer to the tailnet.
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
# The budget for reading ONE request off a peer: the request line, the headers and
# the body together. Without it socketserver never calls settimeout, so a client
# that declares a Content-Length it never sends leaves self.rfile.read(length)
# blocked forever on the ONLY request thread this deliberately single-threaded
# server has: /health stops answering and the idle exit never fires, because
# service_actions runs only between requests. It is the same wedge to_wav's
# timeout=120 already guards for ffmpeg.
#
# It is a budget for the WHOLE read and not a gap between bytes, because a gap is
# not what the wedge needs. A peer dribbling one byte every 600 ms resets a
# per-operation timeout forever and holds the thread exactly as well as a peer
# that sends nothing, so _DeadlineReads below arms an absolute deadline once per
# request and shrinks the socket timeout to what is left of it before every recv.
#
# 300 s is far above any real loopback upload and far below forever, and it is
# deliberately above the client's own ceiling for one chunk: a request the door is
# still waiting on can never be cut by this. --read-timeout-s is what main()
# assigns here, and it also re-assigns Handler.timeout, because the class body
# below is read once at import and would otherwise keep this default while the
# per-request deadline honoured the flag.
READ_TIMEOUT_S = 300.0
# systemd's SD_LISTEN_FDS_START. Passed sockets begin at fd 3 because 0, 1 and 2
# are stdio, and that offset is part of the protocol rather than a choice here.
LISTEN_FDS_START = 3


class State:
    # One lock over both the recognizer object and the idle clock. Held across
    # "load if needed, then decode", so the reaper cannot drop a model out from
    # under a request that just loaded it.
    lock = threading.RLock()
    recognizer = None
    fake = False
    # What the command line asked for. Reported by /health whether or not it is
    # loaded, and never a constant in this file.
    model = ""
    runtime = ""
    idle_s = 600.0
    # When true the idle deadline ENDS THE PROCESS instead of unloading in place.
    # Off by default, because the process leaving is only correct when something
    # starts it again on the next request.
    exit_on_idle = False
    # Set by the reaper under the lock, acted on by the serve loop between
    # requests. Two steps rather than one because the reaper must not be the
    # thread that stops the server: see Server.service_actions.
    exit_requested = False
    # Requests being handled right now. Only the EXIT consults it, never the
    # unload: see reaper_tick for why those two differ.
    in_flight = 0
    socket_activated = False
    # Monotonic, not wall clock: the idle window must not move when the Pi's
    # clock is stepped by NTP after a boot without an RTC.
    last_request = None
    started_mono = 0.0
    last_load_ms = None
    served = 0
    loads = 0
    unloads = 0


STATE = State()


def idle_s_now():
    """Seconds since the last COMPLETED request, or since start if there was none.

    /health reads this and never writes it. A health probe that reset the clock
    would pin the model warm forever, which is the exact opposite of what this
    file exists to do.
    """
    since = STATE.last_request if STATE.last_request is not None else STATE.started_mono
    return time.monotonic() - since


def to_wav(src, dst):
    """Convert anything ffmpeg reads into the 16 kHz mono wav the model wants.

    A voice note arrives as ogg or m4a and ffmpeg is the only thing here that
    reads either.
    """
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", dst],
        capture_output=True,
        # A hung ffmpeg would hold the ONLY request thread this server has,
        # forever: health stops answering and every voice note quietly goes cold
        # until somebody restarts the unit. Conversion itself is seconds even for
        # a long note, so 120 s only ever fires on a genuinely wedged ffmpeg (the
        # client's own ceiling is 240 s, sized to the chunked decode of a 5 min
        # note). TimeoutExpired is an Exception, so the handler answers 500 and
        # serves on.
        timeout=120,
    )
    if proc.returncode != 0:
        # ffmpeg's own stderr names the real problem (a truncated upload, an
        # unknown codec). It carries no transcript, so handing it back is safe,
        # and it is the only thing that makes a conversion failure diagnosable
        # from the caller's side.
        err = proc.stderr.decode("utf-8", "replace").strip().replace("\n", " ")
        raise RuntimeError("ffmpeg failed: " + (err[:300] or "no output"))


def decode_wav(path):
    """Decode one 16 kHz mono wav with the resident recognizer.

    ONE STREAM, because the client has already cut the note into pieces of a
    bounded length and this is one of them. The frames are int16 scaled to
    float32 in [-1, 1), which is the arithmetic the recognizer wants.
    """
    import numpy as np

    with wave.open(path) as f:
        frames = f.readframes(f.getnframes())
        rate = f.getframerate()
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768
    stream = STATE.recognizer.create_stream()
    stream.accept_waveform(rate, samples)
    STATE.recognizer.decode_stream(stream)
    audio_s = len(samples) / float(rate) if rate else 0.0
    return stream.result.text.strip(), audio_s


# --- the model lifecycle ------------------------------------------------------


class FakeRecognizer:
    """The stub backend --fake loads instead of the real one.

    It exists so the load / unload / reload logic can be exercised on any machine
    with no venv and no 650 MB of weights on disk. It is loaded, dropped and
    reloaded through EXACTLY the same code below as the real recognizer, because
    a fake that bypassed the lifecycle would make the suite prove nothing about
    the lifecycle. What it does NOT prove is the memory: a stub holds no weights,
    so the RSS numbers in the README come from a real run, never from this.
    """

    def decode(self):
        time.sleep(FAKE_DECODE_S)
        return FAKE_TEXT, FAKE_AUDIO_S


def load_backend():
    """Build the recognizer. Returns (object, load_ms). Never touches STATE."""
    # monotonic, like every other duration here: this Pi has no RTC, the socket
    # unit can start this process at any point in a boot, and an NTP step during
    # a load would otherwise print a negative number into the journal the README
    # quotes its reload measurements from.
    t0 = time.monotonic()
    if STATE.fake:
        time.sleep(FAKE_LOAD_S)
        return FakeRecognizer(), int((time.monotonic() - t0) * 1000)
    # The weights are looked for BEFORE the library is imported. A household that
    # has not built the runtime directory is missing both, and the directory is
    # the thing an operator can fix, so it is the thing the refusal names.
    model_dir = os.path.join(STATE.runtime, "model")
    needed = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    for name in needed:
        path = os.path.join(model_dir, name)
        if not os.path.exists(path):
            raise RuntimeError("model file missing: " + path)

    import sherpa_onnx
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(model_dir, "encoder.int8.onnx"),
        decoder=os.path.join(model_dir, "decoder.int8.onnx"),
        joiner=os.path.join(model_dir, "joiner.int8.onnx"),
        tokens=os.path.join(model_dir, "tokens.txt"),
        # Four, because the Pi has four cores and one decode runs at a time.
        num_threads=4,
        model_type="nemo_transducer",
    )
    return rec, int((time.monotonic() - t0) * 1000)


def ensure_loaded():
    """Load if the reaper dropped it. CALL WITH THE LOCK HELD."""
    if STATE.recognizer is not None:
        return False
    rec, ms = load_backend()
    STATE.recognizer = rec
    STATE.last_load_ms = ms
    STATE.loads += 1
    print(
        "transcribe-server: loaded %s in %d ms (load #%d)"
        % (loaded_model_name(), ms, STATE.loads),
        file=sys.stderr,
        flush=True,
    )
    return True


def unload(why):
    """Drop the recognizer and give the pages back. CALL WITH THE LOCK HELD.

    Dropping the reference runs sherpa-onnx's C++ destructor, which frees the
    weights, but glibc keeps the freed arenas mapped, so without the trim RSS
    would stay near the loaded figure. gc.collect() clears the reference cycles
    onnxruntime leaves behind, and malloc_trim(0) is the glibc call that actually
    returns the arenas to the kernel. It does not exist on macOS, where the
    allocator returns large blocks by itself, so the failure to find it is
    expected there and never an error.

    THIS CANNOT REACH ZERO and nothing here should pretend it does. The shared
    objects stay mapped and the interpreter heap stays allocated after the weights
    go: 67 MB measured on the small box this runs on, and 418 MB right after the
    unload on a development Mac, where the trim call does not exist. The only
    thing that reaches zero is the process not existing, which is --exit-on-idle.
    """
    if STATE.recognizer is None:
        return False
    STATE.recognizer = None
    STATE.unloads += 1
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - not glibc, nothing to trim, not a fault
        pass
    print(
        "transcribe-server: unloaded after %.1fs idle (%s, unload #%d)" % (idle_s_now(), why, STATE.unloads),
        file=sys.stderr,
        flush=True,
    )
    return True


def loaded_model_name():
    """The backend that is really resident, or None while nothing is.

    /health reports this BESIDE the model the command line asked for, because a
    health endpoint that answered with an unloaded model's name would be the one
    lie that makes every other field in it worthless.
    """
    if STATE.recognizer is None:
        return None
    return FAKE_NAME if STATE.fake else STATE.model


def idle_deadline_passed():
    """True when the window has run out and nothing is being served right now.

    CALL WITH THE LOCK HELD. The in-flight count is what the lock alone does not
    cover: ffmpeg converts OUTSIDE the lock and the reply is written after the
    lock is released, so a request can be live at a moment when the lock is free.
    """
    return STATE.in_flight == 0 and idle_s_now() >= STATE.idle_s


def reaper_tick():
    """One pass of the idle clock. Split out so a test can drive it directly."""
    # The deadline is re-checked HERE, inside the lock, not by the caller: a
    # request may have loaded the model and stamped the clock in the moment
    # between the thread waking and the lock being granted.
    with STATE.lock:
        if STATE.idle_s <= 0:
            return False
        if STATE.exit_on_idle:
            # The exit does NOT wait for a model to be resident. Unloading
            # nothing is a no-op, but a socket-activated process that sat through
            # a failed request and then stayed forever is hundreds of megabytes
            # held for nothing, so the window ends the process either way.
            #
            # And the exit is the one that consults in_flight, because it is the
            # irreversible one. An unload landing between a request's ffmpeg and
            # its decode costs that request a reload and nothing else, which is
            # the rule stated above, that only a COMPLETED decode resets the window.
            # An exit landing there would cost the person their voice note.
            STATE.exit_requested = idle_deadline_passed()
            return STATE.exit_requested
        if STATE.recognizer is None:
            return False
        if idle_s_now() < STATE.idle_s:
            return False
        return unload("idle")


def start_reaper():
    """A daemon THREAD, not a timer inside the request loop, and here is why.

    HTTPServer.serve_forever() owns the main thread and blocks in select, so
    there is no request loop to hang a timer off: with no traffic at all, the
    process would never wake to notice it has been idle for ten minutes, which is
    the exact case the unload exists for. (Its select does time out on a poll
    interval, but that is an implementation detail of serve_forever, not a
    contract, and the decision belongs in one place either way.) The thread makes
    the DECISION in both modes. In exit-on-idle mode it does not carry it out:
    see Server.service_actions. A daemon thread wakes on its own clock
    and dies with the process, so nothing has to be joined on shutdown. The
    SERVER stays single-threaded (plain HTTPServer, not the threading one): on a
    4-core Pi one decode already takes all four threads, so two at once would
    make both slower and double the peak memory.
    """
    if STATE.idle_s <= 0:
        # Never-reclaim was asked for, so there is nothing for a thread to do and
        # spinning one at 5 Hz to return immediately is worse than not having it.
        # --idle-s 0 outranks --exit-on-idle: no window means no deadline to act on.
        print("transcribe-server: idle reclaim disabled (--idle-s 0), no unload and no exit", file=sys.stderr, flush=True)
        return None
    # Tick derived from the window rather than fixed, so a short window is
    # actually honoured. At the deployed 600 s this wakes every 5 s, which is
    # nothing. At a test's 1.5 s it wakes every 0.375 s, so the suite does not
    # sit out a fixed tick it did not ask for.
    tick = min(5.0, max(0.2, STATE.idle_s / 4.0))

    def run():
        while True:
            time.sleep(tick)
            try:
                reaper_tick()
            except Exception as e:  # noqa: BLE001 - the reaper must outlive any one failure
                print("transcribe-server: reaper error: %s" % e, file=sys.stderr, flush=True)

    t = threading.Thread(target=run, name="idle-reaper", daemon=True)
    t.start()
    return t


def transcribe_bytes(body):
    """The one path both backends take, real and fake, in this order.

    Convert (real only), take the lock, load if the reaper dropped it, decode,
    and stamp the idle clock ON COMPLETION rather than on arrival. Stamping at
    arrival would let a 75 s decode of a 5 minute note be reaped out from under
    itself the moment it crossed the window.

    Only a COMPLETED decode resets the window. A run of failing requests (a
    truncated upload, a codec ffmpeg will not read) leaves the clock running and
    the model can be dropped while such requests are still arriving, which is
    right: a request that never reached the recognizer is not a reason to hold
    1,300 MB. It is stated here because "traffic was arriving and it unloaded
    anyway" reads like a bug until you know it is the rule.
    """
    src = None
    dst = None
    try:
        fd, src = tempfile.mkstemp(prefix="imprnt-transcribe-", suffix=".bin")
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        wav = None
        if not STATE.fake:
            # ffmpeg runs OUTSIDE the lock: it needs no model, and holding the
            # lock through a conversion would block the reaper for no reason.
            fd, dst = tempfile.mkstemp(prefix="imprnt-transcribe-", suffix=".wav")
            os.close(fd)
            to_wav(src, dst)
            wav = dst
        with STATE.lock:
            ensure_loaded()
            t0 = time.monotonic()
            if STATE.fake:
                text, audio_s = STATE.recognizer.decode()
            else:
                text, audio_s = decode_wav(wav)
            decode_ms = int((time.monotonic() - t0) * 1000)
            STATE.served += 1
            STATE.last_request = time.monotonic()
        return text, audio_s, decode_ms
    finally:
        # Both temp files, on every path. A server that runs for weeks and
        # leaks a wav per voice note fills /tmp on a Pi.
        for p in (src, dst):
            if not p:
                continue
            try:
                os.unlink(p)
            except OSError:
                pass


class _DeadlineReads(io.RawIOBase):
    """The connection, read under one deadline for the whole request.

    socketserver's `timeout` is per OPERATION, so it bounds the gap between two
    bytes and never the request. Measured: against a 1 s handler timeout a silent
    peer is dropped at 1.00 s, and a peer sending one byte every 600 ms is never
    dropped at all, while /health stays unanswered behind it. Same wedge, slower
    client. So the budget is armed once per request and every recv gets what is
    LEFT of it.

    It replaces `rfile` rather than guarding the one `read(length)` call, because
    the request line and the headers come through the same file and a dribbled
    header is the same wedge as a dribbled body.
    """

    def __init__(self, conn, budget):
        self._conn = conn
        self._budget = budget
        self._end = None

    def readable(self):
        return True

    def arm(self):
        self._end = time.monotonic() + self._budget

    def disarm(self):
        """Give the socket its plain budget back before the answer goes out.

        The response is written through this same socket. Leaving the spent tail
        of the deadline on it would hand a reply that comes after a 3 s decode
        whatever milliseconds the upload happened to leave behind, and a full send
        buffer would then fail a request that worked.
        """
        self._end = None
        self._conn.settimeout(self._budget)

    def readinto(self, buf):
        if self._end is not None:
            left = self._end - time.monotonic()
            if left <= 0:
                raise socket.timeout("request not read inside %ss" % self._budget)
            self._conn.settimeout(left)
        return self._conn.recv_into(buf)


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 for one concrete reason: curl attaches "Expect: 100-continue" to any
    # body over 1 KB, and BaseHTTPRequestHandler only answers that header when it
    # speaks 1.1. Under 1.0 curl waits out its full 1 s expect timeout before
    # sending a single byte - a fixed second bolted onto every voice note, which
    # would have eaten most of what going warm bought. Keep-alive is then switched
    # off per response, because a single-threaded server must not let one idle peer
    # hold the only slot there is.
    protocol_version = "HTTP/1.1"
    server_version = "imprnt-transcribe"
    sys_version = ""
    # socketserver's StreamRequestHandler.setup() applies this to the accepted
    # connection, and BaseHTTPRequestHandler turns the resulting socket.timeout
    # into a closed connection. That close is quiet: it reports through log_error
    # -> log_message, which is silenced just below. The per-request deadline on
    # top of this lives in _DeadlineReads above.
    timeout = READ_TIMEOUT_S

    def setup(self):
        BaseHTTPRequestHandler.setup(self)
        stock = self.rfile
        self._reads = _DeadlineReads(self.connection, READ_TIMEOUT_S)
        self.rfile = io.BufferedReader(self._reads)
        # The stock makefile() reader is closed rather than dropped: it holds a
        # socketio reference the socket's own close counts down before it lets the
        # fd go.
        stock.close()

    def handle_one_request(self):
        # One budget per request, not per connection: responses carry
        # `Connection: close` so there is normally one request here, but a client
        # that pipelines gets its own deadline for each rather than sharing one.
        self._reads.arm()
        return BaseHTTPRequestHandler.handle_one_request(self)

    def log_message(self, fmt, *args):
        # Silence the stock request line. This process writes its own, below.
        pass

    def _note(self, code, audio_s=None, decode_ms=None, why=""):
        # One line per request on stderr, so journalctl shows the shape of the
        # traffic and which user's door is hitting it. NEVER the transcript: a
        # voice note is personal and the journal is not the vault.
        bits = ["%s %s %s" % (self.command, self.path, code)]
        if audio_s is not None:
            bits.append("audio=%.1fs" % audio_s)
        if decode_ms is not None:
            bits.append("decode=%dms" % decode_ms)
        if why:
            bits.append(why)
        print("transcribe-server: " + " ".join(bits), file=sys.stderr, flush=True)

    def _reply(self, code, payload):
        # Every answer this server gives goes out through here, which makes it the
        # one place the read deadline can be taken off before a byte is written.
        # The response travels the same socket as the request: after a 3 s decode
        # the deadline armed for the upload has milliseconds left on it, and those
        # milliseconds would become the ceiling on the write.
        self._reads.disarm()
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _loopback_ok(self):
        peer = self.client_address[0] if self.client_address else ""
        if peer in LOOPBACK:
            return True
        self._reply(403, {"error": "loopback only"})
        self._note(403, why="peer=" + str(peer))
        return False

    def do_GET(self):
        if not self._loopback_ok():
            return
        if self.path.split("?")[0] != "/health":
            self._reply(404, {"error": "not found"})
            self._note(404)
            return
        # `ok` is true while the model is unloaded, on purpose: unloaded IS the
        # designed steady state, so a probe that read ok=false at idle would call
        # the working case a fault ten minutes after every voice note. `ok` says
        # the process is answering. `loaded` says whether the weights are in.
        # Read without the lock: this server is single-threaded, so no request
        # can be mid-decode while this one runs, and the reaper thread only ever
        # rebinds these attributes, which is atomic in CPython. The lock would
        # buy nothing here, and it is not what keeps /health responsive - a GET
        # arriving DURING a decode waits in the listen backlog either way, which
        # is the cost of one decode at a time and is written down in the README.
        self._reply(
            200,
            {
                "ok": True,
                "loaded": STATE.recognizer is not None,
                "idle_s": round(idle_s_now(), 2),
                # What the command line asked for, and what is really in.
                "model": STATE.model,
                "loaded_model": loaded_model_name(),
                "last_load_ms": STATE.last_load_ms,
                "idle_limit_s": STATE.idle_s,
                # Monotonic, so an NTP step on a Pi with no RTC cannot make
                # this go backwards or jump. Same reason as the idle window.
                "uptime_s": round(time.monotonic() - STATE.started_mono, 1),
                "served": STATE.served,
                "loads": STATE.loads,
                "unloads": STATE.unloads,
            },
        )
        self._note(200)

    def do_POST(self):
        if not self._loopback_ok():
            return
        if self.path.split("?")[0] != "/transcribe":
            self._reply(404, {"error": "not found"})
            self._note(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0:
            # A declared length is required rather than supported-and-streamed,
            # so the cap below is enforced BEFORE 25 MB is read into memory. Every
            # caller here is curl over a file on disk, which always sends one.
            self._reply(411, {"error": "Content-Length required (send the audio as the raw body)"})
            self._note(411)
            return
        if length > MAX_BODY:
            self._reply(413, {"error": "body over %d bytes" % MAX_BODY})
            self._note(413, why="bytes=%d" % length)
            return

        body = self.rfile.read(length)
        # Counted from before the conversion to after the reply, which is wider
        # than the lock on purpose: ffmpeg runs outside the lock and the reply is
        # written after it is released. The idle EXIT reads this count.
        with STATE.lock:
            STATE.in_flight += 1
        try:
            text, audio_s, decode_ms = transcribe_bytes(body)
            self._reply(200, {"text": text, "audio_s": round(audio_s, 2), "decode_ms": decode_ms})
            self._note(200, audio_s, decode_ms)
        except Exception as e:  # noqa: BLE001 - any failure, same answer
            # Answer and KEEP SERVING. A single bad clip must never take the
            # process down, because the whole point of this process is that the
            # model load is paid once per idle window, not once per clip.
            msg = str(e).replace("\n", " ")
            self._reply(500, {"error": msg[:300]})
            self._note(500, why="error=" + msg[:120])
        finally:
            with STATE.lock:
                STATE.in_flight -= 1


# --- the socket: our own, or the one systemd already bound ---------------------


def adopt_listen_fd():
    """Return systemd's listening socket, or None when nobody passed one.

    systemd hands a socket-activated service its listening sockets as fd 3
    upwards, with LISTEN_FDS saying how many and LISTEN_PID saying which pid they
    were meant for. The pid check is the whole safety of the scheme: those two
    variables are ordinary environment, so a grandchild that re-execs would
    otherwise adopt whatever it happens to have open on fd 3. Both are removed
    from the environment either way, which is what sd_listen_fds() does too, so
    the ffmpeg this process spawns never sees them.
    """
    count = os.environ.pop("LISTEN_FDS", "")
    want_pid = os.environ.pop("LISTEN_PID", "")
    os.environ.pop("LISTEN_FDNAMES", None)
    if not count:
        return None
    if want_pid.strip() != str(os.getpid()):
        print(
            "transcribe-server: LISTEN_FDS set but LISTEN_PID is %r, not this pid %d - binding our own socket"
            % (want_pid, os.getpid()),
            file=sys.stderr,
            flush=True,
        )
        return None
    try:
        n = int(count)
    except ValueError:
        return None
    if n < 1:
        return None
    # Family and type are read off the fd rather than assumed. The unit that
    # ships here declares one AF_INET stream socket, but reading them means an
    # IPv6 ListenStream is not silently treated as IPv4 (verified by hand:
    # socket.socket(fileno=fd) reports AF_INET/SOCK_STREAM for a bound listener).
    sock = socket.socket(fileno=LISTEN_FDS_START)
    if n > 1:
        # Only the first is used. Saying so is better than serving one of several
        # ports and leaving the rest silently unaccepted.
        print("transcribe-server: LISTEN_FDS=%d, using only fd %d" % (n, LISTEN_FDS_START), file=sys.stderr, flush=True)
    return sock


class Server(HTTPServer):
    """HTTPServer that can adopt a pre-bound socket and can stop when idle."""

    def __init__(self, address, handler, sock=None):
        if sock is None:
            HTTPServer.__init__(self, address, handler)
            return
        # The socket already exists, is already bound and has already had
        # listen() called on it by systemd before this process started, so
        # bind_and_activate=False: binding again would fail with EADDRINUSE
        # against our own service. address_family is set first so the throwaway
        # socket socketserver makes for us matches the one we are replacing.
        self.address_family = sock.family
        HTTPServer.__init__(self, address, handler, bind_and_activate=False)
        self.socket.close()
        self.socket = sock
        self.server_address = sock.getsockname()
        # server_bind() normally sets these two and we skipped it. A handler that
        # reads them (they are part of the http.server contract) must not find
        # them missing just because the bind happened elsewhere.
        self.server_name = socket.getfqdn(self.server_address[0])
        self.server_port = self.server_address[1]

    def service_actions(self):
        """The one place this process may leave. Called by serve_forever's loop.

        Not from the reaper thread, for two reasons. The reaper holds the lock
        when it decides, and a request that is blocked waiting for that same lock
        would deadlock anything that tried to join the serve loop from there. And
        this hook runs BETWEEN requests - serve_forever calls it after
        _handle_request_noblock() has returned - so on a single-threaded server
        the exit structurally cannot happen mid-request. That is a stronger
        guarantee than the lock or the in-flight count, both of which stay as
        forward defence for the day somebody swaps in ThreadingHTTPServer.

        The deadline is re-checked here under the lock, the same discipline the
        reaper follows: a voice note may have arrived and completed in the gap
        between the reaper deciding and this loop coming round.
        """
        if not STATE.exit_requested:
            return
        with STATE.lock:
            if not idle_deadline_passed():
                STATE.exit_requested = False
                return
            idle = idle_s_now()
        # Named on stderr, because a journal reader watching a service stop over
        # and over deserves to know it is the design and not a crash loop.
        print(
            "transcribe-server: exiting on idle after %.1fs with no request (served %d, exit 0)" % (idle, STATE.served),
            file=sys.stderr,
            flush=True,
        )
        # SystemExit rather than os._exit: it unwinds through main(), whose
        # finally closes the server, and it is exit code 0 because an idle exit
        # is a success. os._exit would skip that and buy nothing here.
        raise SystemExit(0)


def warm_up():
    # One decode of a second of silence. The first decode after a load is where
    # onnxruntime allocates its arenas and first touches the int8 weights, so
    # without this the FIRST real voice note - the one a human is waiting on -
    # pays that cost instead of the load paying it.
    import numpy as np

    stream = STATE.recognizer.create_stream()
    stream.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
    STATE.recognizer.decode_stream(stream)


def main():
    # EVERY KNOB IS AN ARGUMENT. Nothing below reads the environment, so the whole
    # behaviour of this process is on the command line the unit renders, where an
    # operator can read it.
    ap = argparse.ArgumentParser(
        description="loopback speech recognizer, one chunk per request"
    )
    ap.add_argument("--warm", action="store_true", help="load and decode 1 s of silence at startup")
    ap.add_argument(
        "--port",
        type=int,
        default=8798,
        help="TCP port on 127.0.0.1, or 0 to let the kernel pick (default 8798)",
    )
    ap.add_argument(
        "--idle-s",
        type=float,
        default=600,
        help="unload the model after this many seconds with no request, 0 to never unload"
        " (default 600)",
    )
    ap.add_argument(
        "--runtime",
        default=None,
        help="the directory holding venv/ and model/, outside this repository."
        " Required unless --fake",
    )
    ap.add_argument(
        "--model",
        default="",
        help="the model this server loads, reported by /health. A household on a"
        " smaller box names a smaller one",
    )
    ap.add_argument(
        "--read-timeout-s",
        type=float,
        default=300,
        help="budget for reading ONE request, head and body together (default 300)",
    )
    ap.add_argument(
        "--fake",
        action="store_true",
        help="stub backend: no model, no converter, fixed text, same load and unload path",
    )
    ap.add_argument(
        "--exit-on-idle",
        action="store_true",
        help="end the process at the idle deadline instead of unloading in place; only correct when"
        " something restarts it on the next request",
    )
    args = ap.parse_args()

    # The runtime directory is where the rented parts live and there is no
    # sensible default for it: a guessed path would make a misconfigured unit
    # look like a working one until the first voice note.
    if not args.fake and not args.runtime:
        sys.exit("transcribe-server: --runtime is required (the directory holding venv/ and model/)")

    STATE.fake = args.fake
    STATE.model = args.model or (FAKE_NAME if args.fake else "")
    STATE.runtime = args.runtime or ""
    STATE.idle_s = args.idle_s
    STATE.exit_on_idle = args.exit_on_idle
    STATE.started_mono = time.monotonic()

    # The read budget reaches BOTH places that use it. The class body above is
    # read once at import, so assigning only the module global would leave the
    # socket on the default while the per-request deadline honoured the flag.
    global READ_TIMEOUT_S
    READ_TIMEOUT_S = args.read_timeout_s
    Handler.timeout = args.read_timeout_s

    # Checked here, loudly, rather than discovered per request. Without the
    # converter /health would still answer ok while every decode failed, which is
    # a service that looks alive and is quietly useless. Under a service manager
    # the PATH comes from the unit, so this is also the guard on that being wrong.
    # The stub backend converts nothing, so it must not be gated on a tool it
    # never calls.
    if not STATE.fake and not shutil.which("ffmpeg"):
        sys.exit("transcribe-server: ffmpeg is not on PATH")

    # LAZY BY DEFAULT. The model loads on the first request, so a booted and idle
    # box carries nothing rather than a gigabyte waiting for a voice note that may
    # not come today. --warm is the opt-in for the other trade, which is what the
    # resident unit renders: pay the load at boot so the first note is fast, and
    # find out at STARTUP rather than on that note that the weights are missing.
    if args.warm:
        with STATE.lock:
            try:
                ensure_loaded()
            except Exception as e:  # noqa: BLE001
                sys.exit("transcribe-server: %s" % e)
            if not STATE.fake:
                t0 = time.monotonic()
                warm_up()
                print("transcribe-server: warmed in %.1fs" % (time.monotonic() - t0), file=sys.stderr, flush=True)

    start_reaper()

    passed = adopt_listen_fd()
    STATE.socket_activated = passed is not None
    httpd = Server(("127.0.0.1", args.port), Handler, sock=passed)
    # The BOUND address, not the requested one, for two reasons. --port 0 is
    # usable, because the caller reads this line to learn where the kernel put it,
    # which is how two checks can drive their own server at the same time.
    # And under socket activation this process did not choose the address at all,
    # so printing a hardcoded 127.0.0.1 would print a lie into the journal the day
    # somebody hands this process a socket bound to something other than loopback.
    host, port = httpd.server_address[0], httpd.server_address[1]
    print(
        "transcribe-server: listening on %s:%d (model %s, idle %.1fs%s%s%s)"
        % (
            host,
            port,
            STATE.model,
            STATE.idle_s,
            ", warm" if args.warm else ", lazy",
            ", socket-activated on fd %d" % LISTEN_FDS_START if STATE.socket_activated else "",
            # Only when there is a window to act on, so this line cannot
            # contradict the "idle reclaim disabled" one above it.
            ", exits on idle" if STATE.exit_on_idle and STATE.idle_s > 0 else "",
        ),
        file=sys.stderr,
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
