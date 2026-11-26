"""Build a clean-install SD archive with the public Sync Test clips."""

import argparse
from pathlib import Path
import shutil
import tempfile

from build_release import ROOT, load_config, run, sha256, write_zip
from prepare_sdcards import write_card_boot_files


def build(output, ffmpeg):
    config = load_config(ROOT / "config/syncplayer.json")
    config.update(apply_ptp_settings=True, group_id="syncplayer-demo", loop_mode="reschedule", output_mode="3840x2160x50p")
    trust = ROOT / "updates/update-trust.pem"
    version = (ROOT / "VERSION").read_text(encoding="ascii").strip()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"StartWebcast-SyncPlayer-{version}-SD-Install.zip"
    with tempfile.TemporaryDirectory(prefix="syncplayer-sd-install-") as temporary:
        root = Path(temporary)
        holding = root / "HOLDING.jpeg"
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
             "-i", "color=black:s=1920x1080", "-frames:v", "1", "-threads", "1",
             "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-update", "1", str(holding)])
        for player in sorted(config["players"].values()):
            card = root / f"Player{player}"
            media = card / "media"
            media.mkdir(parents=True)
            shutil.copyfile(holding, media / holding.name)
            clip = media / f"Presentation_{player}.mp4"
            shutil.copyfile(ROOT / f"test-content/Sync Test_{player}.mp4", clip)
            write_card_boot_files(card, config, player, {
                f"media/{filename.name}": sha256(filename) for filename in (media / holding.name, clip)
            })
            shutil.copyfile(trust, card / "clock/update-trust.pem")
            (card / "presentation-title.txt").write_text("Sync Test\n", encoding="ascii")
        package = {str(path.relative_to(root)).replace("\\", "/"): path for path in root.glob("Player*/**/*") if path.is_file()}
        package["START-HERE.md"] = ROOT / "docs/SD-INSTALL.md"
        write_zip(archive, package)
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "releases")
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("FFmpeg is required")
    print(build(args.output.resolve(), ffmpeg))


if __name__ == "__main__":
    main()
