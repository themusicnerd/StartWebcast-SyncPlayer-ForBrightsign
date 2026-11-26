# Changelog

## 0.2.12

- Request a group playhead jump from any admitted player. The leader announces a native PTP playback state for the requested position.
- Show decoder position reports and differences in the Players panel.
- Reduce the corner radius and top padding of console panels.

## 0.2.11

- Show only the StartWebcast hexagon in the browser tab icon.
- Separate lower-layer playback, window sizing and upper-layer HTML5 overlay controls. Show the active source and the overlay state next to their controls.
- Retry a rejected native MP4 loop using a new native sync timestamp on the leader.

## 0.2.10

- Enable HDMI audio on every player by default. Select any combination of active players in Group Membership, or set HDMI Audio on each player.
- Use `0.au.pool.ntp.org` for the factory default time server. Keep operator-selected time servers and disabled NTP settings.

## 0.2.9

- Add per-player Output Rotation next to Output Resolution. Rotate the native video, web layers and holding image by the same angle.

## 0.2.8

- Use the bundled StartWebcast mark as the browser tab icon.

## 0.2.7

- Keep playback and the HTML5 overlay running while the schedule sends HDMI-CEC display power commands.
- Share the display schedule with admitted followers through the authenticated leader heartbeat.
- Check update slot names with BrightScript operations supported on XD236.

## 0.2.6

- Add offline console and API help with short procedures, HTTPS examples and common request bodies.

## 0.2.5

- Stage signed application updates from a local file or a configurable GitHub repository and branch. Install on restart with a previous-version fallback and rollback.
- Show HDMI-reported TV power, local HDMI-CEC Power On and Standby controls, and snapshots in the player header.
- Add a dedicated Add Player selector for provisioned followers and a switch for the saved display schedule. Use Title Case for console controls and link the logo to StartWebcast.

## 0.2.4 · 26 November 2026

- Keep navigation in view and highlight the current section. Balance the dashboard in equal two-, three- and four-column sections.
- Add operator controls for including and excluding provisioned followers. Media requirements follow the active roster.
- Update the playhead from the device once per second. Add native Pause and Resume and let operators drag the playhead during local MP4 playback.

## 0.2.3 · 26 November 2026

- Use the bundled transparent HTML compositor for the overlay above native MP4 and SRT sources as well as webpages.

## 0.2.2 · 26 November 2026

- Add native video brightness, hue and saturation controls to the console and API.
- Add opt-in Art-Net unicast or sACN multicast input for colour and transport, with a console source address, DMX patch and media slots.

## 0.2.1 · 26 November 2026

- Wait for fresh peer confirmation before restoring a synchronized library revision after a restart.
- Verify cached follower assets by SHA-256 before reporting them ready again.
- Compose the lower webpage and upper HTML5 overlay in a single browser widget. Overlay URLs apply to the current session.

## 0.2.0 · 26 November 2026

- Add the full-width purple StartWebcast SyncPlayer console, with orange branding and packaged StartWebcast artwork.
- Add streamed MP4 uploads, metadata and hash validation, versioned library, follower distribution, native controls and a LAN API.
- Add player monitoring, HDMI, volume, Sydney schedule, NTP, role and PTP settings, plus independent Standalone playback.
- Add the resizable lower source window for MP4, SRT and webpages, with a separate HTML5 overlay.

## 0.1.6 · 26 November 2026

- Encode clock result flags as strings for the BrightSignOS 9.1.82 Node message bridge.

## 0.1.5 · 26 November 2026

- Add a provisioned, LAN-only HTTPS clock page to the leader card. Operators can copy the computer clock or enter Sydney date and time manually.
- Set the leader's real-time clock through BrightScript and report the time read back from it.

## 0.1.4 · 26 November 2026

- Validate player membership by enumeration and indexed lookup to avoid a BrightScript runtime failure on BrightSignOS 9.1.82.
- Confirmed on Player A that the clock survives reboot, the presentation starts and HDMI output is 3840 × 2160 at 50 Hz.

## 0.1.3 · 26 November 2026

- Use a separate startup script on each presentation card to configure Ethernet and optional authenticated local diagnostics before loading playback.
- Record startup stages and any returned playback errors in a bounded SD report.

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
