"""Run the BrightScript call-path tests in the pinned Roku desktop interpreter."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from build_release import ROOT


def main():
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise SystemExit("npm is required for desktop BrightScript mocks")
    source = (ROOT / "src/autorun.brs").read_text(encoding="utf-8")
    source, replaced = re.subn(r"(?im)^Sub Main\(\)$", "Sub BenchMain()", source, count=1)
    if replaced != 1:
        raise SystemExit("Could not isolate the hardware entry point")
    bootstrap = (ROOT / "src/card_bootstrap.brs").read_text(encoding="utf-8")
    bootstrap, replaced = re.subn(r"(?im)^Sub Main\(\)$", "Sub CardBootstrapMain()", bootstrap, count=1)
    if replaced != 1:
        raise SystemExit("Could not isolate the card bootstrap entry point")
    mock = ROOT / "tests/desktop/native_mock.brs"
    with tempfile.TemporaryDirectory(prefix="start-syncplayer-test-") as temporary:
        runtime = Path(temporary) / "bench.brs"
        runtime.write_text(source + "\n" + bootstrap + "\n" + mock.read_text(encoding="utf-8"), encoding="utf-8")
        command = [npm, "exec", "--yes", "--package=brs@0.45.0", "--", "brs", str(runtime)]
        result = subprocess.run(
            command, cwd=temporary, text=True, capture_output=True, timeout=120,
        )
    print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="")
    if result.returncode or "NATIVE_MOCK_TESTS_PASSED" not in result.stdout.splitlines():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
