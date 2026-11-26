# AGENTS.md | Start SyncPlayer

Project owner: Adrian Davis / Start Webcast Pty Ltd
Working product name: Start SyncPlayer

## Mission
Build a production-quality, standalone, LAN-managed synchronised media player application for BrightSign XD236 (Series 6). Read PROJECT_SPEC.md before implementing. The initial deployment is three players, A/B/C; design for configurable group size. Do not require BrightAuthor, an external control server, cloud, internet, or paid runtime services.

## Working instructions
- Inspect the repository first; preserve existing work. Establish Git history and small reviewable changes. Never push, deploy, erase media, change firmware or modify live network settings without explicit authorisation.
- Start with a minimal hardware proof of concept before building the CMS. Maintain docs/API_VERIFICATION.md with official reference URLs, OS/runtime version, exact API signatures, test evidence and unresolved issues. Do not invent BrightScript methods or assume desktop Node APIs are available.
- Use native BrightSign hardware video decoding and native PTP/SyncManager timing. Never substitute JavaScript timers, NTP or simultaneous HTTP commands for frame synchronisation.
- Preferred architecture: BrightScript autorun and playback engine, roNodeJs for HTTP and content management, documented message-port bridge. Verify exact capabilities on XD236 firmware; alternative documented native APIs are acceptable if justified. Keep the browser UI separate from the playback engine.
- Use Australian English in UI/docs; accessible, responsive, keyboard-friendly interface. Brand as Start SyncPlayer / Start Webcast, not AVIT. Do not assign an open-source licence without owner approval.
- Keep runtime dependencies small, pinned, auditable and bundled offline. Stream large uploads and downloads; never buffer an entire movie in RAM. Keep event loops nonblocking and limit concurrent I/O.
- Use explicit state machines, versioned manifests, immutable asset IDs, SHA-256 verification, timeouts, retries with backoff, idempotent commands and structured bounded logs. Persist state atomically where supported; test interruption recovery. Keep previous known-good content until replacement is fully committed.
- Treat all uploads, filenames, manifests and network requests as untrusted. Prevent traversal, symlink escapes, injection, oversized requests and unauthorised downloads. Use authenticated administration, per-installation credentials, peer authentication and CSRF protection. Never ship a shared default password or log secrets. Document LAN-only HTTP limitations and HTTPS options; do not expose to internet.
- Do not silently downgrade synchronisation, claim a player is in sync from heartbeat alone, or label unverified media as valid. Distinguish measured, reported and unknown status.
- No fabricated test results. Desktop tests may mock hardware but must be labelled as such. Hardware tests require three real XD236 units and measured output. Record failures, logs, firmware and reproduction steps.

## Development workflow
1. Verify API and OS compatibility; produce an architecture decision record and runnable minimal sync demo.
2. Implement playback state machine and recovery; validate on hardware before adding transfer load.
3. Implement management HTTP API, commissioning and web UI.
4. Implement staged uploads, metadata checks, distribution, durable commits and rollback.
5. Add integration API, fault injection, packaging, operator and commissioning guides.

At each milestone run relevant tests, update README, CHANGELOG and docs, and report completed work, known limitations, hardware tests still needed and next action. If hardware is unavailable, continue with mocks and clearly mark hardware acceptance pending. Keep deployment builds reproducible; never package real credentials, customer media or logs.

## Suggested repository layout
```
AGENTS.md
PROJECT_SPEC.md
README.md
CHANGELOG.md
src/autorun.brs
src/playback/
src/sync/
src/server/
src/web/
config/
tests/unit/
tests/integration/
tests/hardware/
tools/
docs/
releases/
```
Adapt source layout to verified BrightSign script loading and packaging requirements. The released ZIP must place autorun.brs at the SD root and include all required runtime assets.

## Definition of done
A fresh installation can commission three players from a browser, upload three matching files, distribute and verify them, play and loop in native sync, recover from expected faults, and operate offline. All mandatory acceptance tests in PROJECT_SPEC.md must pass before a production-ready claim. Provide reproducible build, deployment ZIP, source, API documentation and test report.
