# StartWebcast SyncPlayer

StartWebcast SyncPlayer runs from microSD on BrightSign XD236. It supports standalone playback and native PTP/SyncManager group playback. See the hardware checklist for output alignment measurements.

| Screen | Role | Primary Ethernet address |
| --- | --- | --- |
| A | Leader | `192.168.1.11` |
| B | Follower | `192.168.1.12` |
| C | Follower | `192.168.1.13` |

## Bench setup

Use the same release ZIP on all three players. [SD quick start](docs/SD-QUICK-START.md) covers card layout, the wired PTP domain and first boot. [Hardware checklist](docs/HARDWARE_TEST.md) covers timing measurements, faults, evidence and rollback. The application starts automatically from card and uses the address already assigned to `eth0`.

## Prepared content cards

For a clean installation, use the SD Install ZIP with the matching Player A, B or C folder. It includes the generated Sync Test clips and the public OTA verification key. Provision your own management credentials. [SD Install Guide](docs/SD-INSTALL.md) · [GitHub Releases](https://github.com/themusicnerd/StartWebcast-SyncPlayer-ForBrightsign/releases)

Prepare dedicated A/B/C cards for a matched 4K25 set. Each card commissions its static IPv4 address, shows a startup identification screen and enables HDMI audio. The daily 07:00–21:00 Sydney schedule uses HDMI-CEC to control the displays. Each card can also commission password-protected BrightSign diagnostics at boot. [Content Card Guide](docs/CONTENT-CARDS.md)

Provisioned cards host the full-width purple management console on HTTPS port 8080. The [operator and API guide](docs/SUITE.md) covers uploads, the library, monitoring, HDMI/audio, clock and NTP, Standalone mode, group PTP settings, source layers and sACN/Art-Net controls.

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
node --test tests/desktop/*.test.js
```

The console includes native playback controls, group membership, live player snapshots, system status and a timed IDENT overlay. The lower layer accepts MP4, SRT, RTSP and webpages. Use a separate HTML5 page for the upper layer. [Console Guide](docs/SUITE.md) · [App Updates](docs/UPDATES.md)

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

See the [architecture decision](docs/ADR-001-NATIVE-SYNC.md), [API verification](docs/API_VERIFICATION.md), [hardware checklist](docs/HARDWARE_TEST.md) and [changelog](CHANGELOG.md) for the remaining hardware acceptance work.
