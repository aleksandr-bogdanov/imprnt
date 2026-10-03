#!/usr/bin/env python3
"""Provision a NEW optional voice runtime. Never edits registry or services.

Run with CPython 3.11–3.13; ffmpeg must already be installed by the OS owner.
Failures preserve the partial directory for inspection; choose a fresh path.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
NEEDED = ('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def download(spec, dest):
    if not spec['url'].startswith('https://'):
        raise ValueError('model download requires HTTPS')
    with urllib.request.urlopen(spec['url'], timeout=60) as response, dest.open('xb') as out:
        if not response.url.startswith('https://'):
            raise ValueError('model redirect requires HTTPS')
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > spec['size']:
                raise ValueError('model download exceeds pinned size')
            out.write(block)
    if size != spec['size'] or sha256(dest) != spec['sha256']:
        raise ValueError('model checksum or size mismatch')


def extract(archive, root, model):
    """Validate the entire archive before writing, and never follow tar links."""
    with tarfile.open(archive, 'r:bz2') as tar:
        members = tar.getmembers()
        names, total = set(), 0
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts
                    or path.parts[0] != model or '\\' in member.name
                    or not (member.isdir() or member.isfile()) or path in names):
                raise ValueError('unsafe model archive member')
            names.add(path)
            total += member.size
            if len(names) > 10000 or total > 2 * 1024**3:
                raise ValueError('model archive exceeds extraction budget')
        for member in members:
            target = root.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with tar.extractfile(member) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o600)
    for name in NEEDED:
        path = root / model / name
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError('required model file missing or empty: ' + name)


def smoke(python, runtime, model, env):
    # Load the exact existing backend and exercise ffmpeg plus a real silence
    # decode. No listener, service, microphone, private audio or fake backend.
    code = '''import importlib.util, io, sys, wave
spec = importlib.util.spec_from_file_location("hub_transcriber", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE.runtime, m.STATE.model = sys.argv[2:4]
b = io.BytesIO()
with wave.open(b, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\\0" * 32000)
text, seconds, _ = m.transcribe_bytes(b.getvalue())
assert seconds == 1.0 and isinstance(text, str)
print("voice runtime: real recognizer and ffmpeg smoke passed")
'''
    subprocess.run([str(python), '-I', '-B', '-c', code, str(HERE / 'transcribe-server.py'), str(runtime), model],
                   env=env, check=True, timeout=300)


def install(runtime):
    if platform.python_implementation() != 'CPython' or sys.version_info[:2] not in [(3, 11), (3, 12), (3, 13)]:
        raise ValueError('run with CPython 3.11, 3.12 or 3.13 (pinned binary wheels)')
    if platform.system() not in ('Darwin', 'Linux') or platform.machine() not in ('arm64', 'aarch64', 'x86_64'):
        raise ValueError('supported platforms: macOS/Linux ARM64 or x86-64')
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise ValueError('install ffmpeg with your OS package manager first')
    subprocess.run([ffmpeg, '-version'], check=True, stdout=subprocess.DEVNULL, timeout=15)
    spec = json.loads((HERE / 'voice-runtime.lock.json').read_text())
    model = spec['model']['directory']
    # Reserve the final path: venv scripts have absolute shebangs and must not
    # be moved after creation. Existing directories and symlinks always refuse.
    runtime = Path(os.path.abspath(runtime))
    if runtime.parent.resolve() != runtime.parent:
        raise ValueError('use a canonical parent path without symlink aliases')
    runtime.mkdir(mode=0o700)
    print('Preparing fresh runtime; failures retain this directory: ' + str(runtime), flush=True)
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR')}
    home = runtime / '.setup-home'; home.mkdir(mode=0o700)
    env['HOME'] = str(home)
    subprocess.run([sys.executable, '-I', '-m', 'venv', str(runtime / 'venv')], env=env, check=True, timeout=120)
    python = runtime / 'venv/bin/python'
    subprocess.run([str(python), '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
                    'install', '--no-cache-dir', '--only-binary=:all:', '--require-hashes',
                    '--index-url', 'https://pypi.org/simple', '-r', str(HERE / 'voice-runtime.requirements.txt')],
                   env=env, check=True, timeout=600)
    archive = runtime / 'model.tar.bz2'
    download(spec['model'], archive)
    extract(archive, runtime, model)
    smoke(python, runtime, model, env)
    files = {str(p.relative_to(runtime)): {'sha256': sha256(p), 'size': p.stat().st_size}
             for p in sorted((runtime / model).rglob('*')) if p.is_file()}
    with (runtime / 'READY.json').open('x') as f:
        json.dump({'version': 1, 'model': model, 'lock_sha256': sha256(HERE / 'voice-runtime.lock.json'),
                   'requirements_sha256': sha256(HERE / 'voice-runtime.requirements.txt'),
                   'files': files, 'smoke': 'real-silence-decode-and-ffmpeg'}, f, indent=2)
        f.write('\n')
    print(json.dumps({'runtime': str(runtime), 'model': model, 'ready': True,
                      'activation': 'Declare these paths in the registry; no services were changed.'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True, help='new directory in an existing canonical parent; never overwritten')
    args = parser.parse_args()
    try:
        install(args.runtime)
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as exc:
        parser.exit(1, 'voice setup failed: ' + str(exc) + '\nNo service or registry was changed; any partial directory was retained.\n')


if __name__ == '__main__':
    main()
