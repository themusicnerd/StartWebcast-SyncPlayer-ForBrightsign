# Start SyncPlayer

Start Webcast's native three-player XD236 sync proof of concept, version **0.1.0**. It boots from microSD, plays a distinct frame-counter clip on each screen, and uses BrightSign's native video decoder and PTP/SyncManager timing. Hardware acceptance is pending.

| Screen | Role | Primary Ethernet address |
| --- | --- | --- |
| A | Leader | `192.168.1.11` |
| B | Follower | `192.168.1.12` |
| C | Follower | `192.168.1.13` |

## Bench setup

Use the same release ZIP on all three players. [SD quick start](docs/SD-QUICK-START.md) covers card layout, the wired PTP domain and first boot. [Hardware checklist](docs/HARDWARE_TEST.md) covers timing measurements, faults, evidence and rollback. The application starts automatically from card and uses the address already assigned to `eth0`.

## Build and verify

On a workstation, use Python 3.11 or newer, FFmpeg with `libx264` and `drawtext`, and ffprobe. On Windows the generator defaults to Consolas. On Linux it defaults to DejaVu Sans Mono. Pass `--font` to select a different TrueType font. For bit-for-bit reproduction, use the same inputs, exact FFmpeg and ffprobe builds, font bytes and platform. The ZIP contains `BUILD-INFO.json` with tool versions and the font hash. FFmpeg and fonts live on the workstation only.

```powershell
python tools/build_release.py
python -m unittest discover -s tests/desktop -v
```

The build writes the SD ZIP and its SHA-256 sidecar to `releases/`. The ZIP contains root-level `autorun.brs`, the configuration, build information, checksums, quick start and one test clip per ID. The runtime has zero third-party dependencies.

With npm on the workstation, run the BrightScript source through desktop fakes and check the script syntax. npm may fetch the pinned tools when first run. Neither command deploys the script.

```powershell
python tools/test_native_mocks.py
npm exec --yes --package=brighterscript@0.73.8 -- bsc --no-project --files src/autorun.brs --create-package false --copy-to-staging false
```

## Configuration

The source is `config/syncplayer.json`. To produce a different common SD build, pass `--config path/to/syncplayer.json`. Keep membership, group, PTP domain and loop mode identical across every card on a bench. Configurable membership is supported by the package generator. The intended hardware test is three units.

| Key | Meaning |
| --- | --- |
| `schema_version` | Configuration format. Use integer 1. |
| `group_id` | SyncManager domain. Use 1–48 lowercase ASCII letters, digits or hyphens. Use a distinct name for each bench group. |
| `ptp_domain` | PTP clock domain, integer 0–127. Default 15. |
| `apply_ptp_settings` | Opt-in to writing the PTP registry settings and rebooting if necessary. Default `false`. |
| `enable_genlock` | Opt-in native HDMI output sync request for a separate phase test. Default `false`. Reboot every unit before changing mode. |
| `loop_mode` | `seamless` requests seamless-only native looping. `reschedule` lets A schedule a new native start after each clip ends. |
| `leader_id` | One player ID from the mapping. Default A. |
| `players` | An object mapping 2–26 unique IPv4 addresses to unique uppercase letters A–Z. |

## Scope

The release covers the first task in the [product specification](PROJECT_SPEC.md). It has no CMS, browser commissioning, peer transfers or REST interface. The [implementation plan](docs/IMPLEMENTATION_PLAN.md) gates that work on native bench results. See the [architecture decision](docs/ADR-001-NATIVE-SYNC.md), [API verification](docs/API_VERIFICATION.md), [test report](docs/TEST_REPORT.md) and [changelog](CHANGELOG.md).
