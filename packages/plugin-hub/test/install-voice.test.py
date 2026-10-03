"""Offline installer boundary tests. Real download/decode is a separate disposable proof."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).parents[1] / 'tools/install-voice.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class VoiceInstall(unittest.TestCase):
    def archive(self, root, extras=()):
        file = root / 'model.tar.bz2'
        with tarfile.open(file, 'w:bz2') as tar:
            for name in m.NEEDED:
                info = tarfile.TarInfo('model/' + name); info.size = 4
                tar.addfile(info, io.BytesIO(b'data'))
            for info in extras:
                tar.addfile(info, io.BytesIO(b'x' * info.size))
        return file

    def test_extract_preserves_exact_required_bytes_without_archive_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); m.extract(self.archive(root), root, 'model')
            for name in m.NEEDED:
                self.assertEqual((root / 'model' / name).read_bytes(), b'data')
                self.assertEqual((root / 'model' / name).stat().st_mode & 0o777, 0o600)

    def test_entire_archive_validated_before_any_model_write(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('model/link', tarfile.SYMTYPE), ('model/hard', tarfile.LNKTYPE),
                           ('model/encoder.int8.onnx', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); member = tarfile.TarInfo(name); member.type = kind; member.linkname = '/outside'
                with self.assertRaises(ValueError):
                    m.extract(self.archive(root, [member]), root, 'model')
                self.assertFalse((root / 'model').exists())

    def test_download_rejects_changed_bytes_and_excess_size(self):
        class Response(io.BytesIO):
            url = 'https://upstream.example/model'
        for body in [b'evil', b'too long']:
            with tempfile.TemporaryDirectory() as tmp, patch.object(m.urllib.request, 'urlopen', return_value=Response(body)):
                spec = {'url': Response.url, 'size': 4, 'sha256': hashlib.sha256(b'good').hexdigest()}
                with self.assertRaises(ValueError):
                    m.download(spec, Path(tmp) / 'download')

    def test_existing_runtime_and_symlink_are_never_modified(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(m.sys, 'version_info', (3, 13)), patch.object(m.shutil, 'which', return_value='/fixture/ffmpeg'), patch.object(m.subprocess, 'run'):
            root = Path(tmp).resolve(); runtime = root / 'runtime'; runtime.mkdir()
            kept = runtime / 'original'; kept.write_bytes(b'original runtime')
            alias = root / 'alias'; alias.symlink_to(runtime)
            for dest in [runtime, alias]:
                with self.assertRaises(FileExistsError):
                    m.install(dest)
            self.assertEqual(kept.read_bytes(), b'original runtime')
            self.assertEqual(list(runtime.iterdir()), [kept])

    def test_failed_smoke_preserves_partial_runtime_without_ready_marker(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(m.sys, 'version_info', (3, 13)), patch.object(m.shutil, 'which', return_value='/fixture/ffmpeg'), patch.object(m.subprocess, 'run'), patch.object(m, 'download'), patch.object(m, 'extract'), patch.object(m, 'smoke', side_effect=ValueError('decode failed')):
            runtime = Path(tmp).resolve() / 'fresh'
            with self.assertRaisesRegex(ValueError, 'decode failed'):
                m.install(runtime)
            self.assertTrue(runtime.is_dir())
            self.assertFalse((runtime / 'READY.json').exists())

    def test_wheel_lock_and_requirements_cover_exact_same_hashes(self):
        lock = json.loads((m.HERE / 'voice-runtime.lock.json').read_text())
        requirements = (m.HERE / 'voice-runtime.requirements.txt').read_text()
        for package in lock['packages']:
            self.assertIn(package['name'] + '==' + package['version'], requirements)
            for wheel in package['wheels']:
                self.assertIn('--hash=sha256:' + wheel['sha256'], requirements)
        self.assertEqual(requirements.count('--hash='), sum(len(p['wheels']) for p in lock['packages']))


if __name__ == '__main__':
    unittest.main()
