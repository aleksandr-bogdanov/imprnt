# Fresh local voice runtime

This optional setup command prepares a **new** runtime for the existing transcriber. It does not modify the registry, start services, install OS packages, or replace an existing runtime. An installed household does not need to run it.

Install CPython 3.11, 3.12 or 3.13 with venv/pip support and ffmpeg through your OS package manager. Use an existing, canonical parent directory owned by the service account, outside agent-writable trees. Run as that account, without sudo:

```sh
python3.13 packages/plugin-hub/tools/install-voice.py --runtime /absolute/canonical/path/voice-new
```

The command downloads approximately 487 MB of model archive plus binary Python wheels. Allow at least 2 GB of disk space and sufficient memory for loading the model. It creates `venv/` and `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`, verifies downloads, and runs the existing backend through ffmpeg and a real one-second silence decode. Only after that succeeds does it write `READY.json` with model file hashes. No audio is recorded or sent to a provider. Silence decoding validates runtime compatibility, not recognition accuracy.

The installer currently pins sherpa-onnx and sherpa-onnx-core 1.13.8, numpy 2.2.6, and the upstream Parakeet TDT v3 int8 archive. PyPI wheel hashes are in `tools/voice-runtime.requirements.txt`, with filenames/provenance in `tools/voice-runtime.lock.json`. Installation requires those hashes and binary wheels only; it does not build unpinned source distributions. The model digest is the SHA-256 published on the [upstream release asset](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2). Its format and supported languages are documented by [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html). Licenses and other bundled model files remain in the extracted directory.

The wheel lock covers macOS and glibc Linux ARM64/x86-64 with CPython 3.11–3.13. Missing/incompatible wheels refuse installation. macOS ARM64/Python 3.13 was exercised with the real model; Linux and the other interpreter/platform combinations have published pinned wheels but were not runtime-tested here. Python 3.14 and musl Linux are outside this installer's support boundary. ffmpeg remains an OS-managed prerequisite; its installation/version is not pinned by this command.

After `READY.json` exists, set the recognizer's existing registry fields to the printed paths:

```toml
[recognizers.local]
provider = "sherpa-onnx"
runtime = "/absolute/canonical/path/voice-new"
model = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
chunk_seconds = 60
```

Keep the household's selected recognizer and transcriber run-entry configuration explicit. Use the normal Hub check/service installation workflow for activation. The setup command does not select a recognizer for you.

An existing destination, including a symlink, is always refused. A failure retains the partial directory and never writes `READY.json`; inspect it and choose a different fresh destination for retry. Do not move a completed runtime: venv scripts embed its absolute path. The downloaded archive is retained for verification. There is no automatic update or repair of an existing runtime.

Offline boundary checks:

```sh
python3 packages/plugin-hub/test/install-voice.test.py
```
