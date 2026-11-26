# ADR 001 · Native sync for the XD236 bench

**Decision date** 26 November 2026

**Status** Accepted for the proof of concept. Hardware acceptance pending.

BrightScript `autorun.brs` reads the assigned address on the primary Ethernet interface (`eth0`). A common SD configuration maps addresses to IDs and specifies one leader. The same package boots all units. Address assignment remains an installation action.

`roSyncManager` advertises the fixed test-content revision and a PTP timestamp. The leader uses the event returned by `Synchronize()`. Followers use native `roSyncManagerEvent` notifications, including the currently advertised state when they boot late. Each copy of `roVideoPlayer` supplies its own local file and the same native timing fields. PTP runs over the wired bench switch on domain 15 by default. The package can explicitly configure those PTP registry keys and reboot once. It starts only when the configured keys match.

The default is `SeamlessLoopOrNotAtAll` for the supplied silent assets. A media-end event in that mode is an error. An explicit `reschedule` bench mode lets the leader schedule each transition through `roSyncManager` after native media-end. The expected gap in that mode is measured on the bench. The optional `SetSyncDomain()` exercise is separate from the baseline video sync measurement.

The bench build uses the vendor's default SyncManager transport and is for a trusted, isolated network. It exposes no HTTP service. Asset selection is limited to the locally assigned counter clip. The bench app has no membership readiness protocol, lock telemetry, upload or operator controls.

For the next milestone, keep native playback in BrightScript and evaluate `roNodeJs` for management with a flat message-port contract. Prove the on-device Node version, bridge, storage and networking behaviours before adopting it. This preserves independent playback if the management process fails. Running a browser or Node timer for video timing would bypass the native PTP and decoder path.

See [API verification](API_VERIFICATION.md) for the official sources and bench dependencies.
