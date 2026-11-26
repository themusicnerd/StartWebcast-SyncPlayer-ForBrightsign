# Start SyncPlayer 0.1.0 test report

- **Date** 26 November 2026
- **Release** `Start-SyncPlayer-0.1.0-XD236-SD.zip`
- **SHA-256** `9691d275d432c7978122ec1337baa1e7bb6eba0a6336b1daad07258250db396c`
- **Status** Desktop verification passed. XD236 bench validation is pending.

## Workstation results

| Check | Result |
| --- | --- |
| Release build and independent rebuild | Both builds produced the same ZIP SHA-256 on Windows with the same Python, FFmpeg, ffprobe and font. Tool versions and font hash are embedded in `BUILD-INFO.json`. |
| Configuration and release tests | Five Python tests passed. They cover the requested mapping, invalid and duplicate configuration, alternate group membership, root paths, exact archived source and config, ZIP integrity and per-entry and file-level SHA-256. |
| BrightScript syntax | BrighterScript 0.73.8 reported zero errors and one warning, BS1013. This Roku-oriented parser expects a referenced source file. BrightSign loads the root `autorun.brs` directly. |
| BrightScript call path with fakes | The Roku desktop interpreter `brs` 0.45.0 exercised the committed source with fake manager, event and video objects. Assertions passed for valid and invalid config, leader/follower role calls, the 500 ms native schedule, exact timestamp forwarding, distinct local clip paths, missing time and rejected schedule/play requests. |
| MP4 timing and decode | FFmpeg decoded all three delivered MP4s without errors. Each has one video track, H.264 High level 4.2, 1920×1080 at exactly 60/1 fps, 600 frames over ten seconds, PTS/DTS starting at zero, even frame ticks and a keyframe every 60 frames. Container metadata precedes media data. Average bitrates are approximately 0.82, 0.77 and 0.78 Mb/s for A, B and C. |
| Frame artwork spot check | Extracted frames confirmed the A, B and C labels and distinct backgrounds. A's sample showed the first and last counters (000000 and 000599) and the first-frame flash. |

Commands and build inputs are in the repository README. The desktop interpreter uses fake BrightSign objects. No player firmware, native decoding, PTP lock or HDMI output was exercised.

## XD236 results

| Check | Status |
| --- | --- |
| Boot, firmware/API smoke, primary Ethernet role mapping and offline run | Pending |
| Three-output steady-state frame difference | Pending |
| Seamless loop gaps and eight-hour / 100-transition endurance | Pending |
| Follower late join, Ethernet reconnect, leader and group recovery | Pending |
| Optional HDMI Genlock and phase measurement | Pending |

Use the [hardware checklist](HARDWARE_TEST.md) to attach actual firmware, switch and display details, logs and simultaneous output captures. The product specification's full production acceptance suite remains pending.
