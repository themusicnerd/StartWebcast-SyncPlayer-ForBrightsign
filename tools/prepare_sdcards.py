"""Prepare three offline BrightSign card folders from a 4K25 HEVC presentation."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from fractions import Fraction
from ipaddress import IPv4Interface
from pathlib import Path

from build_release import ROOT, fast_start, json_bytes, load_config, run, sha256


IDS = "ABC"
FAT32_LIMIT = (1 << 32) - 1


def preflight(ffprobe, path):
    if path.stat().st_size > FAT32_LIMIT:
        raise ValueError(f"{path.name} exceeds the FAT32 file limit")
    if not fast_start(path):
        raise ValueError(f"{path.name} needs a fast-start MP4 remux before preparation")
    result = run([
        ffprobe, "-v", "error", "-show_streams", "-show_packets", "-show_format",
        "-show_entries", "packet=stream_index,pts,dts,duration,flags",
        "-of", "json", str(path),
    ], capture_output=True, text=True)
    info = json.loads(result.stdout)
    if len(info["streams"]) != 2:
        raise ValueError(f"{path.name} must contain one video and one audio track")
    video, audio = info["streams"]

    expected_video = {
        "codec_type": "video", "codec_name": "hevc", "profile": "Main",
        "pix_fmt": "yuv420p", "width": 3840, "height": 2160, "avg_frame_rate": "25/1",
        "r_frame_rate": "25/1", "start_pts": 0,
    }
    expected_audio = {
        "codec_type": "audio", "codec_name": "aac", "profile": "LC",
        "sample_rate": "48000", "channels": 2, "start_pts": 0,
    }
    if any(video.get(key) != value for key, value in expected_video.items()) or not 0 < video["level"] <= 180:
        raise ValueError(f"{path.name} is missing the expected 4K25 HEVC Main video track")
    if any(audio.get(key) != value for key, value in expected_audio.items()):
        raise ValueError(f"{path.name} is missing the expected 48 kHz stereo AAC-LC track")

    video_packets = [packet for packet in info["packets"] if packet["stream_index"] == video["index"]]
    frame_count = int(video["nb_frames"])
    frame_ticks = Fraction(1, 25) / Fraction(video["time_base"])
    if (
        not video_packets or len(video_packets) != frame_count
        or video_packets[0]["pts"] != 0 or "K" not in video_packets[0]["flags"]
        or int(video["duration_ts"]) != frame_count * frame_ticks
        or abs(Fraction(info["format"]["duration"]) - Fraction(frame_count, 25)) > Fraction(1, 10000)
        or any(packet["duration"] != frame_ticks for packet in video_packets)
        or any(pts != index * frame_ticks for index, pts in enumerate(sorted(p["pts"] for p in video_packets)))
    ):
        raise ValueError(f"{path.name} has a discontinuous or incomplete video timeline")

    audio_packets = sorted(
        (packet["pts"], packet["duration"])
        for packet in info["packets"] if packet["stream_index"] == audio["index"]
    )
    audio_tick = Fraction(audio["time_base"])
    audio_end = int(audio["duration_ts"])
    if (
        not audio_packets or audio_packets[0][0] != 0
        or any(duration <= 0 for _, duration in audio_packets)
        or any(pts + duration != next_pts for (pts, duration), (next_pts, _) in zip(audio_packets, audio_packets[1:]))
        or sum(audio_packets[-1]) != audio_end
        or abs(audio_end * audio_tick - Fraction(frame_count, 25)) > Fraction(1, 48000)
    ):
        raise ValueError(f"{path.name} has a discontinuous audio timeline or mismatched duration")
    return frame_count, audio_tick, audio_packets


def checked_copy(source, destination):
    original = hashlib.sha256()
    with source.open("rb") as incoming, destination.open("xb") as outgoing:
        while chunk := incoming.read(4 * 1024 * 1024):
            original.update(chunk)
            outgoing.write(chunk)
    digest = sha256(destination)
    if original.hexdigest() != digest:
        raise OSError(f"Copied bytes failed SHA-256 verification for {source.name}")
    return digest


def make_holding(ffmpeg, ffprobe, source, destination):
    filters = (
        "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2"
        ":flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )
    run([
        ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-i", str(source),
        "-vf", filters, "-frames:v", "1", "-threads", "1",
        "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2", "-update", "1", str(destination),
    ])
    probe = run([
        ffprobe, "-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt",
        "-of", "json", str(destination),
    ], capture_output=True, text=True)
    expected = {"codec_name": "mjpeg", "width": 1920, "height": 1080, "pix_fmt": "yuvj420p"}
    if json.loads(probe.stdout)["streams"] != [expected]:
        raise ValueError("Holding image conversion did not produce a supported 1920 × 1080 JPEG")


def card_targets(output):
    targets = {player: output / f"Player{player}" for player in IDS}
    for target in targets.values():
        if target.resolve() != target:
            raise OSError(f"Card folder points outside its named path: {target}")
        if target.exists() and (not target.is_dir() or any(target.iterdir())):
            raise OSError(f"Card folder has existing contents: {target}. Use a new --output folder.")
    return targets


def prepare(name, content, output, ffmpeg, ffprobe):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise ValueError("Set name must use ASCII letters, digits, underscores or hyphens")
    clips = {player: content / f"{name}_{player}.mp4" for player in IDS}
    holding_source = content / f"{name}_HOLDING.jpg"
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    targets = card_targets(output)
    if not holding_source.is_file():
        raise ValueError(f"Expected holding image {holding_source.name}")
    needed = sum(path.stat().st_size for path in clips.values())
    if shutil.disk_usage(output).free < needed + 16 * 1024 * 1024:
        raise OSError("Insufficient free space for the three card folders")

    for player, clip in clips.items():
        print(f"Checking Player {player}: {clip.name}", flush=True)
        timeline = preflight(ffprobe, clip)
        if player == "A":
            reference = timeline
        elif timeline != reference:
            raise ValueError(f"{clip.name} has a different video frame count or audio timeline from A")

    config = load_config(ROOT / "config/syncplayer.json")
    if set(config["players"].values()) != set(IDS):
        raise ValueError("The card preparation requires the common A/B/C configuration")
    config.update(apply_ptp_settings=True, loop_mode="reschedule", output_mode="3840x2160x50p")
    with tempfile.TemporaryDirectory(prefix=".preparing-", dir=output) as scratch:
        staged = Path(scratch).resolve()
        if staged.parent != output:
            raise OSError("Staging directory must stay inside the card output folder")
        holding = staged / "HOLDING.jpeg"
        make_holding(ffmpeg, ffprobe, holding_source, holding)
        digests = {}
        for player, clip in clips.items():
            destination = staged / targets[player].name / "media"
            destination.mkdir(parents=True)
            print(f"Copying and verifying Player {player}", flush=True)
            digests[player] = checked_copy(clip, destination / f"Presentation_{player}.mp4")
            shutil.copyfile(holding, destination / holding.name)

        group_digest = hashlib.sha256("".join(digests.values()).encode("ascii")).hexdigest()
        config["group_id"] = f"presentation-{group_digest[:24]}"
        for player in IDS:
            directory = staged / targets[player].name
            write_card_boot_files(directory, config, player, {
                "media/HOLDING.jpeg": sha256(directory / "media/HOLDING.jpeg"),
                f"media/Presentation_{player}.mp4": digests[player],
            })

        card_targets(output)
        for target in targets.values():
            if target.exists():
                target.rmdir()
            (staged / target.name).rename(target)
    print(f"Prepared and verified {reference[0]} matched frames per screen in {output}")


def write_card_boot_files(directory, config, player, media_manifest):
    address = next(ip for ip, player_id in config["players"].items() if player_id == player)
    profile = IPv4Interface(f"{address}/24")
    card_config = config | {
        "card_player_id": player,
        "static_ipv4": {
            "address": str(profile.ip),
            "netmask": str(profile.netmask),
            "broadcast": str(profile.network.broadcast_address),
        },
        "display_schedule": {"timezone": "Australia/Sydney", "on": "07:00", "off": "21:00"},
    }
    shutil.copyfile(ROOT / "src/card_bootstrap.brs", directory / "autorun.brs")
    shutil.copyfile(ROOT / "src/autorun.brs", directory / "playback.brs")
    (directory / "syncplayer.json").write_bytes(json_bytes(card_config))
    shutil.copyfile(ROOT / "VERSION", directory / "VERSION")
    app_files = ["autorun.brs", "playback.brs", "syncplayer.json", "VERSION"]
    (directory / "clock").mkdir(exist_ok=True)
    for name in ("server.js", "index.html", "clock.js", "clock.css", "startwebcast.png", "library.js", "mp4.js", "suite.js", "peers.js", "layer.html", "layer.js", "dmx.js"):
        target = f"clock/{name}"
        shutil.copyfile(ROOT / "src" / target, directory / target)
        app_files.append(target)
    manifest = media_manifest | {
        name: sha256(directory / name) for name in app_files
    }
    checksums = "".join(f"{digest}  {name}\n" for name, digest in sorted(manifest.items()))
    (directory / "SHA256SUMS").write_bytes(checksums.encode("ascii"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="Shared source filename before _A.mp4, _B.mp4, _C.mp4 or _HOLDING.jpg")
    parser.add_argument("--content", type=Path, default=ROOT / "content")
    parser.add_argument("--output", type=Path, default=ROOT / "sdcard")
    args = parser.parse_args()
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        parser.error("FFmpeg and ffprobe are required on the workstation")
    try:
        prepare(args.name, args.content.resolve(), args.output, ffmpeg, ffprobe)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr)
        parser.exit(1, f"Card preparation failed. {error}\n")


if __name__ == "__main__":
    main()
