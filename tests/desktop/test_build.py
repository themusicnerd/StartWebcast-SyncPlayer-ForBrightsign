import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from build_release import inspect_counter, load_config  # noqa: E402


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.config_path = ROOT / "config/syncplayer.json"
        self.config = load_config(self.config_path)

    def test_requested_addresses_and_roles(self):
        self.assertEqual(
            self.config["players"],
            {"192.168.1.11": "A", "192.168.1.12": "B", "192.168.1.13": "C"},
        )
        self.assertEqual(self.config["leader_id"], "A")
        self.assertFalse(self.config["apply_ptp_settings"])

    def test_invalid_configuration(self):
        cases = {
            "bad leader": {"leader_id": "D"},
            "traversal in ID": {"players": {"192.168.1.11": "A", "192.168.1.12": "../B"}},
            "duplicate player ID": {"players": {"192.168.1.11": "A", "192.168.1.12": "A"}},
            "invalid address": {"players": {"192.168.1.256": "A", "192.168.1.12": "B"}},
            "multicast address": {"players": {"224.0.126.10": "A", "192.168.1.12": "B"}},
            "invalid domain": {"ptp_domain": 128},
            "incorrect flag type": {"enable_genlock": 1},
            "unknown config key": {"unknown": "ignored"},
        }
        with tempfile.TemporaryDirectory() as temporary:
            bad_config = Path(temporary) / "syncplayer.json"
            for name, override in cases.items():
                with self.subTest(name=name):
                    bad_config.write_text(json.dumps(self.config | override), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        load_config(bad_config)

    def test_duplicate_json_key(self):
        text = self.config_path.read_text(encoding="utf-8").replace(
            '"192.168.1.11": "A",', '"192.168.1.11": "A", "192.168.1.11": "B",',
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "syncplayer.json"
            path.write_text(text, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate configuration key"):
                load_config(path)

    def test_more_players_and_alternate_leader(self):
        config = copy.deepcopy(self.config)
        config["players"]["192.168.1.14"] = "D"
        config["leader_id"] = "D"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "syncplayer.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            self.assertEqual(load_config(path), config)


class ReleaseTests(unittest.TestCase):
    def test_delivered_archive(self):
        version = (ROOT / "VERSION").read_text(encoding="ascii").strip()
        path = ROOT / "releases" / f"Start-SyncPlayer-{version}-XD236-SD.zip"
        self.assertTrue(path.is_file(), "Build the release before testing")
        expected_archive_sum, expected_name = path.with_suffix(".zip.sha256").read_text().strip().split()
        self.assertEqual(expected_name, path.name)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected_archive_sum)
        clips = {f"media/FrameCounter_{player_id}.mp4" for player_id in "ABC"}
        with zipfile.ZipFile(path) as archive:
            files = archive.namelist()
            expected = clips | {"autorun.brs", "syncplayer.json", "SHA256SUMS",
                                "BUILD-INFO.json", "SD-QUICK-START.md", "VERSION"}
            self.assertEqual(len(files), len(expected))
            self.assertEqual(set(files), expected)
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("autorun.brs"), (ROOT / "src/autorun.brs").read_bytes())
            self.assertIn(f'fields.version = "{version}"'.encode(), archive.read("autorun.brs"))
            self.assertEqual(json.loads(archive.read("syncplayer.json")), load_config(ROOT / "config/syncplayer.json"))
            manifest = dict(
                reversed(line.split("  ", 1))
                for line in archive.read("SHA256SUMS").decode("ascii").splitlines()
            )
            self.assertEqual(set(manifest), expected - {"SHA256SUMS"})
            for name, digest in manifest.items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest, name)
            self.assertEqual(len({manifest[clip] for clip in clips}), 3)
            self.check_media(archive, clips)

    def check_media(self, archive, clips):
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        self.assertTrue(ffmpeg and ffprobe, "Install FFmpeg and ffprobe on the test workstation")
        with tempfile.TemporaryDirectory() as temporary:
            for name in sorted(clips):
                with self.subTest(clip=name):
                    path = Path(archive.extract(name, temporary))
                    self.assertEqual(inspect_counter(ffprobe, path)["frames"], 600)
                    subprocess.run([
                        ffmpeg, "-v", "error", "-xerror", "-nostdin", "-i", str(path), "-f", "null", "-",
                    ], check=True)


if __name__ == "__main__":
    unittest.main()
