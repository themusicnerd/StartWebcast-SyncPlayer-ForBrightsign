# Start SyncPlayer | Product specification

**Owner:** Adrian Davis / Start Webcast Pty Ltd  
**Status:** Development brief, not implemented or hardware validated  
**Initial target:** Three BrightSign XD236 Series 6 players  
**Working release:** 0.1.0 proof of concept

## 1. Objective and boundaries
Enable nontechnical operators to upload and select sets of distinct, frame-aligned video files using a web browser. One BrightSign hosts the management webpage and plays its own video; followers play their own local files. No external control server, BrightAuthor, internet, cloud account or subscription is needed during operation. An engineering workstation may be used for development and deployment only. Future groups may have more or fewer screens. Do not promise support for other models until tested.

## 2. Architecture
```
Operator browser / optional Q-SYS REST client
                  | LAN HTTP(S)
           Ethernet switch (same VLAN)
          /           |            \
 XD236 A leader   XD236 B follower  XD236 C follower
 CMS + HTTP API   peer agent        peer agent
 master library   local B assets    local C assets
 native playback  native playback   native playback
      | HDMI          | HDMI            | HDMI
   Screen A        Screen B          Screen C
```
A hosts the authoritative library, peer registry, orchestration and persistent playback selection. Each peer runs the same package with its own persisted role/ID. A retains all assets for follower replacement; B/C store assigned assets only. Network transfers are for distribution, not live playback. Use wired Ethernet, matched firmware/output modes, and a configurable PTP domain (default proposal 15, verify range and conflicts). Document multicast requirements, switch filtering and IGMP behaviour; avoid changes to shared network infrastructure without approval. No external PTP grandmaster assumed; verify actual configuration.

A is a single point of management and leadership failure. No automatic leader election in v1. Existing follower behaviour on loss of leader must be characterised and documented; proposed policy is continue current verified playback where native sync permits, report degraded status and rejoin safely on leader return. Do not claim frame lock without evidence.

## 3. Native playback proof of concept
Read official architecture docs first. Verify installed BrightSignOS, roNodeJs runtime version, native API signatures, PTP interface/domain settings and HDMI sync capabilities. Prefer roSyncManager and roVideoPlayer in BrightScript with a documented bridge to roNodeJs; consider official JavaScript equivalents if better supported. Use native sync events and timestamped shared playback state; map logical content ID/revision to local filename on each peer. Ensure a late joiner can obtain current state and start at the correct position using the documented native mechanism. Avoid arbitrary seeks or pause during sync. Use seamless native looping only when content meets requirements; otherwise leader media-end triggers a new synchronised transition, not independent follower loops. Explicitly measure gaps and document them. A stop/blackout is a coordinated state transition, not independent pause. Never approximate native sync with browser video timers.

Suggested playback states: BOOT, UNCONFIGURED, IDLE, PREPARING, READY, PLAYING, BLACKOUT, DEGRADED, ERROR. Keep transfer state separate. Use a prepare/ready barrier with command ID, manifest revision, membership and timeout before committing a native synchronised start. Reject stale or duplicate commands safely. On boot reconcile committed content, re-establish PTP and resume last selected valid content if enabled; otherwise idle/black. A follower reboot must not force healthy screens to restart.

## 4. Commissioning
Same SD ZIP on all players; autorun.brs starts automatically. On first boot expose a local setup page on proposed port 8080 (verify availability). Configure unique ID, role, group, expected membership, leader address, PTP domain, display mode and audio policy; persist settings. Prefer DHCP reservations; support manual IP entry/peer registration when discovery fails. Optional UDP discovery scoped to group, with authenticated enrolment; reject duplicate IDs and leaders. Show model, firmware, serial where available, app version, IP, storage, sync status and last seen. Require creation of admin credentials, no universal defaults. Document how to discover IP via DHCP or diagnostic tools, and how to recover/reset configuration without deleting media. Do not interfere with existing diagnostic web server.

## 5. Media library and ingest
Initial naming rule: `<content name>_<player ID>.mp4`, case-insensitive extension and suffix, final underscore suffix only. Examples: Welcome_A.mp4, Welcome_B.mp4, Welcome_C.mp4; Christmas_2026_A.mp4 etc. Preserve human-friendly display name, normalise safely and prevent ambiguous collisions; support spaces, underscores and Unicode with tested rules. Reject unknown/duplicate suffixes, malformed names and unsafe paths. Expected membership controls completeness. A partial group is visible but not playable; upload order does not matter. Allow multiple sets and staged replacement; never overwrite an active asset.

Initial supported media: MP4 H.264/H.265 within verified XD236 limits. Require matching resolution, constant frame rate (including rational values like 60000/1001), video frame count/duration, compatible codec and audio timeline; verify profile, level, bitrate, timestamp origin and fast-start requirements against vendor docs. Default audio output from A only, configurable. No transcoding on player in v1. Use bounded MP4 metadata parsing or a vetted compatible parser; do not assume ffprobe exists on BrightSign. Offer optional workstation preflight using ffprobe and test clip generation, but runtime must remain standalone. Clearly distinguish checks actually performed from warnings or unknown properties. Reject known incompatible sets; do not silently approve unverified mandatory checks. Document recommended encoding presets and seamless-loop limitations.

Manifest fields: schemaVersion, groupId, contentId, displayName, revision, expectedPlayerIds, per-player asset ID, original filename, size, SHA-256, verified metadata, created timestamp and commit status. Store immutable versions; use safe temporary paths, atomic rename where supported, journal/reconciliation for interrupted commits. Version replacement is staged across all required players, then activated only after verification; retain old active revision until safe garbage collection.

## 6. Transfer and storage
Stream browser upload to A staging storage with progress, size limits and free-space checks. Compute SHA-256 while writing or via bounded reads. B/C pull their own assigned asset from authenticated A endpoint; verify size and hash before ready. Support interrupted transfers with safe restart; resumable ranges optional if verified. Limit transfer concurrency and throttle if playback suffers. Never mark ready from upload completion alone. Expose per-peer progress/errors, retry and cancel. Handle disk full and corrupted files without disturbing active content. A must retain master copies plus staging and rollback headroom; example 40 GB per screen needs at least 120 GB active content on A and 40 GB per follower, plus additional capacity. Test actual SD filesystem, large-file support, sustained write/read and power-loss behaviour. Delete only unused revisions after confirmation; never delete active assets. Reconcile partial files on reboot. Replacement follower can re-enrol and retrieve required assets from A.

## 7. Web UI
Responsive local webpage hosted on A; no internet-hosted fonts, libraries or assets. Dashboard: now playing, playback/loop state, peer cards, storage and transfer status. Library: complete/incomplete sets, per-player A/B/C readiness, duration/metadata, upload progress, select/play, replace, delete and retry. Drag/drop or file picker for multiple files. Playback: play selected, stop, restart, blackout, loop on/off. On non-loop completion return to a coordinated idle/black state. Remember last selection and loop preference; auto-resume configurable. Settings: membership, player mapping, network/PTP, output/audio, credentials, diagnostics export. Thumbnails optional if feasible without affecting playback; text fallback acceptable. Clear operator errors and confirmation for destructive actions. No false green sync indicators; unknown is an explicit status.

## 8. API proposal
Version API under /api/v1; optionally offer documented aliases for integration. JSON responses, meaningful HTTP status codes, stable error codes, request IDs; long-running operations return job IDs. Authenticate commands and internal endpoints. Read-only status access also protected by default. Define OpenAPI or equivalent contract and examples for Q-SYS Lua HTTP client.

| Method | Path (relative to /api/v1) | Purpose |
|---|---|---|
| GET | /status | Group and playback state |
| GET | /players | Peer status and readiness |
| GET | /content | Library and revisions |
| POST | /uploads | Stream upload; define multipart or raw protocol |
| GET | /jobs/{id} | Progress and errors |
| POST | /play | contentId, optional revision and loop |
| POST | /stop | Coordinated idle |
| POST | /restart | Coordinated restart |
| POST | /loop | Set boolean loop preference |
| POST | /blackout | Coordinated black output |
| DELETE | /content/{id} | Delete nonactive content with confirmation |

Internal peer enrolment, heartbeat, manifest, prepare/ready and asset download endpoints must be versioned, authenticated and separate from operator access. REST is orchestration only; native SyncManager handles actual playback timing. Q-SYS is optional, not required for any operation. A future UDP control adapter may be added only if authenticated or appropriately isolated and documented.

## 9. Security and observability
LAN management only; do not expose to WAN. Per-installation credentials, hashed passwords with suitable supported KDF, session expiration, CSRF protection, peer credentials, rate limits and input validation. HTTPS if supported and deployable; if HTTP only, require trusted management LAN and document credential interception risk. Restrict file serving to authorised immutable asset IDs. Protect secrets at rest as supported; never include in logs/diagnostics. Logs include app/OS versions, command IDs, peer transitions, native sync events, error codes and transfer progress; rotate and bound disk usage. Report sync quality only where native telemetry or external measurement supports it. Provide exportable diagnostic bundle with redaction.

## 10. Milestones and acceptance tests
M1: verified native sync proof of concept. M2: primary-hosted web UI and commissioning. M3: staged ingest/distribution. M4: failure recovery and security. M5: packaging and production acceptance. Implement desktop unit tests for parsing, manifests, state transitions, API, authentication and error paths; integration tests with mocked peers; hardware scripts and checklists for actual units.

| ID | Mandatory acceptance test | Expected result |
|---|---|---|
| H01 | Fresh SD install on three XD236s | All boot; browser commissioning works without BrightAuthor |
| H02 | Disconnect internet; keep LAN | Upload, play, loop and control still work |
| H03 | Upload out of order, missing C, duplicate/invalid names | Correct grouping; incomplete/invalid content cannot play |
| H04 | Valid three-file set | Each peer receives assigned file; hashes match; ready only after all required peers verify |
| H05 | Frame-counter clips at target output rate | Proposed target: same source frame across outputs, at most one frame discrepancy during steady state; record actual measurements |
| H06 | Continuous playback for 8 hours and at least 100 loop transitions | No accumulating drift, crashes or unexplained frame mismatch; measure loop gaps |
| H07 | Change selection, restart, stop, blackout and nonloop end | Coordinated state transitions; no stale content starts |
| H08 | Power cycle follower mid-play | Rejoins current content at correct position without restarting healthy screens; measure recovery |
| H09 | Power cycle leader and whole group | Last committed selection resumes when ready, or safe idle if disabled; no mixed revisions |
| H10 | Disconnect/reconnect follower Ethernet | Degraded status; safe recovery and documented native behaviour |
| H11 | Upload replacement while current set plays | Old revision remains intact; no visible degradation beyond agreed threshold; new revision selectable after all ready |
| H12 | Interrupt upload/download/commit, corrupt file or fill SD | No partial content becomes playable; recovery/retry works |
| H13 | Replace follower with fresh SD | Enrol and retrieve required media from A |
| H14 | Test traversal, unauthenticated access, duplicate IDs, invalid commands | Rejected safely; no leaked secrets or unauthorised playback |
| H15 | REST control from workstation and optionally Q-SYS | Authenticated commands and status work without external runtime server |
| H16 | Large files and target 4K format during transfer | Measure RAM, I/O, dropped frames and UI response; tune concurrency or document limits |

Use synchronised burnt-in frame counters, identical output modes and a multi-input capture or high-speed camera; account for display processing latency. Record OS, SD, codec, network topology, sample duration and measured mismatch. HDMI electrical/genlock phase is a separate measurement from visible frame alignment; do not claim genlock based only on camera footage. Proposed quantitative targets are subject to owner approval after bench testing. Production release requires documented evidence and approval, not just mock tests.

## 11. Packaging and support
Release ZIP with autorun.brs at root, offline bundled application, setup defaults without secrets, version and checksums. Provide README, quick start, commissioning guide, operator guide, content encoding guide, API documentation, troubleshooting, upgrade/rollback procedure and test report. Upgrades must preserve media and configuration; manual SD-based upgrade acceptable for v1. Do not auto-update firmware. Keep source under owner-controlled Git. Licence and commercial terms are owner decisions; no open-source licence implied.

## 12. Deferred scope
Scheduling, sequential playlists, automatic leader failover, remote internet management, HDMI-CEC, custom Q-SYS plugin, arbitrary mixed-model groups and automated transcoding are later features. Configurable membership is an architectural requirement now, but three-player support is the initial acceptance scope.

## 13. Official references
- [XD236 / Series 6 feature matrix](https://docs.brightsign.biz/hardware/series-6-feature-matrix)
- [Video wall sync architecture](https://docs.brightsign.biz/technical/video-wall-sync-architecture)
- [Video sync](https://docs.brightsign.biz/technical/video-sync)
- [Factors affecting sync](https://docs.brightsign.biz/technical/factors-that-can-affect-sync)
- [Video formats and codecs](https://docs.brightsign.biz/technical/video-formats-and-codecs)
- [HTML to Node migration](https://docs.brightsign.biz/technical/html-to-node-migration)
- [Developer tools](https://docs.brightsign.biz/develop/developer-tools)
- [BrightSignOS 8.1 release history (message port background)](https://docs.brightsign.biz/releases/81)
- [BrightSignOS 8.2 release history (Node sync background)](https://docs.brightsign.biz/releases/82)

These references establish architectural feasibility, not exact compatibility with the installed firmware. Retrieve current object-level API docs for roNodeJs, roSyncManager, roVideoPlayer, roRegistrySection and relevant network/file APIs before writing hardware code. Historical release pages are not recommendations to install old firmware.

## 14. First Codex task
Read AGENTS.md and this specification. Inspect the repository, identify the current XD236 firmware/runtime requirements and verify native API signatures from official documentation. Create a short implementation plan and architecture decision record, then build the smallest deployable native three-player sync proof of concept with generated frame-counter test assets or a reproducible generator, logs, configuration and hardware test instructions. Do not start the full CMS until the native playback path is established. If physical players are inaccessible, provide a reproducible SD package and mark hardware acceptance pending. Do not deploy to live devices without explicit owner approval.
