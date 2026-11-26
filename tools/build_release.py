"""Build a standalone Start SyncPlayer bench SD image and verify its test media."""

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FPS = 60
SECONDS = 10
FRAME_COUNT = FPS * SECONDS
TIMESCALE = 60000
WIDTH, HEIGHT = 1920, 1080
MAX_BITRATE = 6_000_000

COLOURS = ["0x102942", "0x294523", "0x452445", "0x512D21", "0x1A4243"]
CONFIG_KEYS = {
    "schema_version", "group_id", "ptp_domain", "apply_ptp_settings",
    "enable_genlock", "loop_mode", "leader_id", "players",
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate configuration key: {key}")
        result[key] = value
    return result


def load_config(path):
    config = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(config, dict) or config.keys() != CONFIG_KEYS:
        raise ValueError("Configuration must contain exactly the documented keys")
    if type(config["schema_version"]) is not int or config["schema_version"] != 1:
        raise ValueError("Unsupported configuration schema version")
    if not isinstance(config["group_id"], str) or not re.fullmatch(r"[a-z0-9-]{1,48}", config["group_id"]):
        raise ValueError("Group ID must be 1–48 lowercase ASCII letters, numbers or hyphens")
    if type(config["ptp_domain"]) is not int or not 0 <= config["ptp_domain"] <= 127:
        raise ValueError("PTP domain must be an integer from 0 to 127")
    if type(config["apply_ptp_settings"]) is not bool or type(config["enable_genlock"]) is not bool:
        raise ValueError("PTP settings and Genlock flags must be booleans")
    if config["loop_mode"] not in ("seamless", "reschedule"):
        raise ValueError("Loop mode must be seamless or reschedule")

    players = config["players"]
    if not isinstance(players, dict) or not 2 <= len(players) <= 26:
        raise ValueError("Supply between 2 and 26 players")
    player_ids = set()
    for address, player_id in players.items():
        ip = ipaddress.IPv4Address(address)
        if ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_reserved:
            raise ValueError(f"Player address must be a usable IPv4 unicast address: {address}")
        if not isinstance(player_id, str) or not re.fullmatch("[A-Z]", player_id) or player_id in player_ids:
            raise ValueError("Each player ID must be a unique uppercase letter A–Z")
        player_ids.add(player_id)
    if config["leader_id"] not in players.values():
        raise ValueError("Leader ID must match an assigned player")
    return config


def run(command, **kwargs):
    return subprocess.run(command, check=True, stdin=subprocess.DEVNULL, **kwargs)


def tool_version(executable):
    return run([executable, "-version"], capture_output=True, text=True).stdout.splitlines()[0]


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def create_counter(ffmpeg, path, font_path, player_id, colour, fps=FPS, seconds=SECONDS, audio_pulse=False):
    # Use a local relative font filename to avoid platform-specific filter escaping.
    frames = fps * seconds
    filters = ",".join([
        "drawbox=x=128:y=234:w=1664:h=8:c=white:t=fill",
        f"drawtext=fontfile=counter.ttf:text='START SYNCPLAYER  /  SCREEN {player_id}'"
        ":fontcolor=white:fontsize=74:x=(w-tw)/2:y=130",
        r"drawtext=fontfile=counter.ttf:text='%{eif\:n\:d\:6}'"
        ":fontcolor=white:fontsize=320:x=(w-tw)/2:y=(h-th)/2",
        f"drawtext=fontfile=counter.ttf:text='FRAME COUNTER   /   1080p{fps}   /   000000-{frames - 1:06d}'"
        ":fontcolor=white:fontsize=43:x=(w-tw)/2:y=850",
        "drawbox=x=128:y=955:w=1664:h=36:c=white@0.23:t=fill",
        f"drawbox=x=128:y=955:w=1664:h=36:c=white:t=fill:enable='lt(mod(n,{fps}),2)'",
    ])
    audio_source = []
    audio_output = ["-an"]
    if audio_pulse:
        pulse = r"aevalsrc=0.12*sin(2*PI*1000*t)*lt(mod(t\,1)\,0.055)"
        audio_source = ["-f", "lavfi", "-i", f"{pulse}:s=48000:d={seconds}"]
        audio_output = ["-c:a", "aac", "-b:a", "96k", "-ac", "2"]
    run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", f"color=c={colour}:s={WIDTH}x{HEIGHT}:r={fps}:d={seconds}",
        *audio_source, "-filter_threads", "1", "-vf", filters, "-frames:v", str(frames),
        *audio_output, "-c:v", "libx264", "-preset", "veryfast", "-threads", "2",
        "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p",
        "-g", str(fps), "-keyint_min", str(fps), "-sc_threshold", "0", "-bf", "0",
        "-crf", "19", "-maxrate", "6M", "-bufsize", "12M",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-video_track_timescale", str(TIMESCALE), "-fps_mode", "cfr",
        "-use_editlist", "1" if audio_pulse else "0", "-movflags", "+faststart", "-map_metadata", "-1", str(path),
    ], cwd=font_path.parent)


def fast_start(path):
    moov_seen = False
    length = path.stat().st_size
    with path.open("rb") as file:
        while file.tell() + 8 <= length:
            start = file.tell()
            size = int.from_bytes(file.read(4), "big")
            kind = file.read(4)
            header_size = 8
            if size == 1:
                size = int.from_bytes(file.read(8), "big")
                header_size = 16
            if size == 0:
                size = length - start
            if size < header_size or start + size > length:
                return False
            if kind == b"mdat":
                return moov_seen
            if kind == b"moov":
                moov_seen = True
            file.seek(start + size)
    return False


def inspect_counter(ffprobe, path):
    probe = run([
        ffprobe, "-v", "error", "-show_streams", "-show_packets", "-show_format",
        "-of", "json", str(path),
    ], capture_output=True, text=True)
    stream_info = json.loads(probe.stdout)
    streams = stream_info["streams"]
    expected = {
        "codec_type": "video", "codec_name": "h264", "profile": "High", "level": 42,
        "width": WIDTH, "height": HEIGHT, "pix_fmt": "yuv420p", "has_b_frames": 0,
        "r_frame_rate": "60/1", "avg_frame_rate": "60/1", "time_base": f"1/{TIMESCALE}",
        "start_pts": 0, "duration_ts": SECONDS * TIMESCALE, "nb_frames": str(FRAME_COUNT),
    }
    if len(streams) != 1 or any(streams[0].get(key) != value for key, value in expected.items()):
        raise ValueError(f"Unexpected stream format in {path.name}")
    packets = stream_info["packets"]
    tick = TIMESCALE // FPS
    if len(packets) != FRAME_COUNT:
        raise ValueError(f"Wrong packet count in {path.name}")
    for frame, packet in enumerate(packets):
        keyframe = "K" in packet["flags"]
        if (
            packet["pts"] != frame * tick
            or packet["dts"] != frame * tick
            or packet["duration"] != tick
            or keyframe != (frame % FPS == 0)
        ):
            raise ValueError(f"Unexpected timeline at frame {frame} in {path.name}")
    if not fast_start(path):
        raise ValueError(f"Fast-start MP4 check failed in {path.name}")
    bitrate = int(stream_info["format"]["bit_rate"])
    if bitrate > MAX_BITRATE:
        raise ValueError(f"Average bitrate exceeds bench encoding limit in {path.name}")
    return {"frames": len(packets), "duration_seconds": SECONDS, "bitrate": bitrate}


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("ascii")


def write_zip(path, files):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for archive_name, source in sorted(files.items()):
            entry = zipfile.ZipInfo(archive_name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            with source.open("rb") as incoming, archive.open(entry, "w") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)


def build(config_path, output, ffmpeg, ffprobe, font):
    config = load_config(config_path)
    version = (ROOT / "VERSION").read_text(encoding="ascii").strip()
    output.mkdir(parents=True, exist_ok=True)
    name = f"Start-SyncPlayer-{version}-XD236-SD.zip"
    with tempfile.TemporaryDirectory(prefix=".start-syncplayer-", dir=output) as temporary:
        stage = Path(temporary).resolve()
        font_path = stage / "counter.ttf"
        shutil.copyfile(font, font_path)
        (stage / "syncplayer.json").write_bytes(json_bytes(config))
        info = {"ffmpeg": tool_version(ffmpeg), "ffprobe": tool_version(ffprobe), "font_sha256": sha256(font_path)}
        files = {
            "autorun.brs": ROOT / "src/autorun.brs",
            "syncplayer.json": stage / "syncplayer.json",
            "VERSION": ROOT / "VERSION",
            "SD-QUICK-START.md": ROOT / "docs/SD-QUICK-START.md",
        }
        media = {}
        for index, player_id in enumerate(sorted(config["players"].values())):
            clip = stage / f"FrameCounter_{player_id}.mp4"
            create_counter(ffmpeg, clip, font_path, player_id, COLOURS[index % len(COLOURS)])
            media[clip.name] = inspect_counter(ffprobe, clip)
            files[f"media/{clip.name}"] = clip
        info["clips"] = media
        (stage / "BUILD-INFO.json").write_bytes(json_bytes(info))
        files["BUILD-INFO.json"] = stage / "BUILD-INFO.json"
        sums = "".join(f"{sha256(source)}  {entry}\n" for entry, source in sorted(files.items()))
        (stage / "SHA256SUMS").write_bytes(sums.encode("ascii"))
        files["SHA256SUMS"] = stage / "SHA256SUMS"
        archive = stage / name
        write_zip(archive, files)
        checksum = stage / f"{name}.sha256"
        checksum.write_bytes(f"{sha256(archive)}  {name}\n".encode("ascii"))
        archive.replace(output / archive.name)
        checksum.replace(output / checksum.name)
    return output / name


def build_test_content(config_path, output, ffmpeg, font):
    config = load_config(config_path)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sync-test-", dir=output) as temporary:
        work = Path(temporary)
        font_path = work / "counter.ttf"
        shutil.copyfile(font, font_path)
        for index, player in enumerate(sorted(config["players"].values())):
            clip = work / f"Sync Test_{player}.mp4"
            create_counter(ffmpeg, clip, font_path, player, COLOURS[index % len(COLOURS)], fps=25, seconds=30, audio_pulse=True)
            if not fast_start(clip):
                raise ValueError(f"Test clip is missing fast-start metadata for Player {player}")
            clip.replace(output / clip.name)


def main():
    windows_font = Path(os.getenv("WINDIR", r"C:\Windows")) / "Fonts/consola.ttf"
    linux_font = Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config/syncplayer.json")
    parser.add_argument("--output", type=Path, default=ROOT / "releases")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable with libx264 and drawtext")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--font", type=Path, default=windows_font if os.name == "nt" else linux_font)
    parser.add_argument("--test-content", action="store_true", help="Build the 25 fps Sync Test library clips")
    args = parser.parse_args()
    for name in ("ffmpeg", "ffprobe"):
        resolved = shutil.which(getattr(args, name))
        if not resolved:
            parser.error(f"{name} executable not found")
        setattr(args, name, str(Path(resolved).resolve()))
    if not args.font.is_file():
        parser.error("Counter font missing. Pass --font with a monospaced TrueType font.")
    try:
        if args.test_content:
            build_test_content(args.config, args.output.resolve(), args.ffmpeg, args.font)
            print(args.output.resolve())
            return
        path = build(args.config, args.output, args.ffmpeg, args.ffprobe, args.font)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Build failed. {error}\n")
    print(path.resolve())
    print(f"SHA-256 {sha256(path)}")


if __name__ == "__main__":
    main()
