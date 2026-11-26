# Prepared XD236 content cards

Use three spare FAT32 microSD cards with at least 3.2 GB free on each.

1. Copy the **contents** of `sdcard/PlayerA`, `sdcard/PlayerB` and `sdcard/PlayerC` to their respective cards. On each card, `autorun.brs`, `syncplayer.json` and the `media` folder go at the root.
2. Connect the rear LAN ports to the same wired switch. Use `192.168.1.11` for A, `192.168.1.12` for B and `192.168.1.13` for C. The cards check this assignment at boot.
3. Connect displays that accept 4K at 50 Hz. Insert the cards with the players off. Boot B and C, then A. Initial setup can include a reboot for wired PTP domain 15 and a restart to set the HDMI mode. Record the previous PTP and HDMI settings if you need them for rollback.
4. The holding image is placed behind the video plane. A allows a short clock settle then schedules playback automatically. Audio comes from A over HDMI. A schedules the next synced start after each run. Measure the gap at the loop boundary on hardware.

For an HD setup, change `output_mode` to `1920x1080x50p` on all three cards. Editing a file changes its recorded SHA-256. The supplied config targets `3840x2160x50p`.

If playback stays on the holding image, check the LAN addresses and which card went into each unit. When local diagnostics are available, look for `WRONG_PLAYER_CARD`, `LOCAL_CLIP_UNPLAYABLE`, `OUTPUT_MODE_REJECTED`, `NATIVE_READY` and `NATIVE_PLAY_REQUESTED`. Use the [hardware checklist](HARDWARE_TEST.md) to measure frame alignment and recovery.

## Preparing another set

From the repository, run `python tools/prepare_sdcards.py SHARED_STEM --output path/to/empty/folder`. The builder reads the matching A, B and C MP4s and the HOLDING JPEG from `content`. It checks the 4K25 video and audio timelines, preserves each MP4 byte-for-byte, and makes a 1920 × 1080 playback copy of the holding image. Each build has a native group ID derived from its video hashes.

[BrightSign media formats](https://docs.brightsign.biz/technical/video-formats-and-codecs) · [BrightSign image limits](https://docs.brightsign.biz/technical/image-formats) · [Native sync architecture](https://docs.brightsign.biz/technical/video-wall-sync-architecture)
