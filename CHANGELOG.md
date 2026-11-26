# Changelog

## 0.1.2 · 26 November 2026

- Configure A, B and C with the static IPv4 settings carried by their individual cards, before playback setup.
- Add daily Sydney-time display wake and standby via HDMI-CEC, with playback starts coordinated through native SyncManager.

## 0.1.1 · 26 November 2026

- Prepare individual A/B/C cards from matching 4K25 HEVC and AAC MP4s, with byte-for-byte copy verification.
- Add a holding JPEG behind the video plane, card-to-IP validation, 50 Hz output modes and leader-only HDMI audio.
- Enable PTP commissioning on prepared cards and use native leader-rescheduled loops for the AAC presentation. Hardware acceptance remains pending.

## 0.1.0 · 26 November 2026

- Added the standalone XD236 native sync bench app with automatic role assignment for 192.168.1.11–13.
- Added silent 1080p60 frame-counter generation, packet-timeline validation, deterministic SD ZIP packaging and checksums.
- Added opt-in wired PTP setup, native seamless and leader-rescheduled loop modes, and structured diagnostic events.
- Added desktop verification and the three-player hardware checklist. On-device verification and production acceptance are pending.
