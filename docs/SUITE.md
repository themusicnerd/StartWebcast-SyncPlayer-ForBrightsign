# StartWebcast SyncPlayer operator guide

**Group Membership** on the leader lists the current roster. **Add Player** re-admits a provisioned follower. A new physical player needs its card identity and peer credentials before it appears in the selector.

**Clock & Schedule** saves the Sydney wake and standby times. Playback and overlays continue while the schedule controls HDMI-CEC display power. Clear **Enable Display Schedule** and save to use manual display power. Followers use the leader’s display schedule in group mode.

The top bar shows HDMI-reported TV power. **Power On** and **Standby** send local HDMI-CEC commands to the connected display. **Snapshot** captures a 960 × 540 JPEG of the player’s video and graphics output. A snapshot can show content while a television is off, and HDMI adapters or displays can report power differently. [BrightSign HDMI and Screenshot API](https://docs.brightsign.biz/develop/rovideomode) · [BrightSign HDMI-CEC API](https://docs.brightsign.biz/develop/rocecinterface)

**Updates** accepts signed packages from the operator’s computer or a configurable GitHub branch. [App Update Guide](UPDATES.md)

**Media Library** lists the presentation already on the SD card and any media you upload. The generated **Sync Test** clips include a frame counter and a short tone for each second. [Sync Test Clips](../test-content)

Set **Output Rotation** in **HDMI & Audio**. Select 0°, 90°, 180° or 270° clockwise for each player. Save the setting to restart that player. The video and graphics layers rotate together, and the layout window follows the rotated coordinates. [Video Rotation API](https://docs.brightsign.biz/develop/rovideoplayer) · [HTML Widget Rotation](https://docs.brightsign.biz/develop/rohtmlwidget)

All players use HDMI audio by default. Use **Enable Audio** or **Disable Audio** in **Group Membership** on the leader to select any combination of players. In **HDMI & Audio**, set the local audio, volume or mute. The group audio state displays Pending until the follower acknowledges the change.

Open **Help** in the top bar for offline console procedures and API examples. The instructions follow ASD-STE100 style with short commands in operating order. [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)

Use HTTPS on port 8080 from the management LAN. The prepared addresses are `192.168.1.11`, `192.168.1.12` and `192.168.1.13`. Sign in with the installation credentials. The BrightSign diagnostics server uses its own HTTPS address on port 443. The bundled interface and local library work without internet access.

## Playback and media

- **Play Built-In** returns to the presentation on the card. **Stop** clears the video and shows the holding image. **Blackout** hides both layers. **Restart** restarts the selected source. **Loop** controls repeat playback of a local MP4. The schedule sends display power commands while playback continues.
- The playhead shows the native playback position once per second. **Pause** becomes **Resume** after a pause. Drag or use the keyboard to move the playhead. During group playback, use any included player to start the group at the selected position. Group controls become available when the included followers report the same clip and playback state. [BrightSign Video Transport](https://docs.brightsign.biz/develop/rovideoplayer)
- In **Media library**, upload one MP4 per member. Use names such as `Welcome_A.mp4`, `Welcome_B.mp4` and `Welcome_C.mp4`. Fast-start H.264 or H.265 MP4s with constant video frame timing and optional AAC-LC audio are accepted within the documented limits. The leader streams each upload to a temporary file, validates its metadata, checks native playability for its own file, and stores the SHA-256 digest. Each set retains its earlier complete revisions while you upload a replacement.
- **Preview on this player** plays the leader's file locally. **Distribute** publishes a complete revision to the configured followers. Followers download their matching file and verify its size, SHA-256 and native playability. **Play group** requires fresh reports from every follower that confirm the same revision, group, PTP domain and HDMI mode. Timing uses native SyncManager. A reconnecting follower can start on a subsequent native transition. The console reports reachability and readiness separately from measured sync quality.
- In **Standalone**, upload the file for the local player and choose **Play on this player**. The local selection is saved and the player runs without a SyncManager session.
- Delete actions require confirmation. A selected or distributing revision remains protected. Clear distribution when finished with an inactive revision you want to remove.

## Group membership

Use **Group membership** on the leader to add or remove a provisioned follower. The leader keeps its place in the group. Membership applies to media requirements, distribution, and group transport. An updated follower stops group playback after receiving its exclusion on an authenticated heartbeat. Re-added followers can prepare their files and join on a subsequent native start. Update the followers to 0.2.4 before relying on remote exclusion or group Pause and Resume. To introduce an address or player ID to the installation, commission its card and peer credentials first.

## Lower and upper layers

The **Lower Layer** displays one base source. Select **Play Built-In**, choose an MP4 in **Media Library**, or enter an SRT or webpage URL in **Live or Web Source**. Use **Position and Size** to set the lower-layer window as percentages of the display. Live sources run locally with their own timing.

The **Upper Layer** displays a full-screen HTML5 overlay above the lower layer for the current session. Use a transparent page background to show the lower layer through the overlay. **Display Layout** shows the lower-layer window and the overlay outline. A lower webpage and an overlay share one Chromium widget. Both webpages must allow framing. Web content uses standard browser security and has no hardware or Node privileges.

For SRT, use `srt://encoder:port?mode=caller` from a compatible encoder in listener mode, or `srt://0.0.0.0:port?mode=listener` when the encoder initiates the connection. The native SRT source depends on the installed BrightSignOS build or SRT extension. Read the Playback status for a reported start or timeout. Test the actual feed and provider profile before use. [BrightSign SRT support](https://support.brightsign.biz/hc/en-us/community/posts/360038334993-SRT-Secure-Reliable-Transport)

## Settings

- **HDMI & audio** changes the selected player between 4K50 and 1080p50 and sets native MP4 and SRT volume. The mode change restarts the application. Synchronized players use matching output modes. Follower MP4 audio stays muted.
- **Playback mode & PTP** selects Leader, Follower or Standalone. Followers must select the new leader explicitly. Apply the same group name and IEEE 1588 domain to all group members. Change the old leader to a follower as part of a planned handover. Role and domain changes restart the affected player. The console lists domains reported by configured players and IPv4 multicast announcements the optional receive-only listener hears on the local interface. Other VLANs, profiles and unicast timing may be invisible.
- **Clock & Schedule** displays Sydney time, sets the hardware clock and changes the daily CEC wake and standby times. A large clock change can briefly restart playback. **Network Time** accepts an SNTP-compatible hostname or IPv4 address and the polling interval. The factory default is `0.au.pool.ntp.org`. Clear the hostname to disable network time. Use 0 for the vendor default interval. NTP maintains wall clock time. Native PTP supplies group playback timing.

## Lighting input

Select **sACN multicast** (UDP 5568) or **Art-Net unicast** (UDP 6454) under **Lighting & colour**. Patch the console to the player's configured IPv4 address for Art-Net. Configure a single private console IPv4 address, universe and first channel. Lighting input is off by default. Use it on an isolated lighting or management LAN. An IP match limits input to the expected console address. Art-Net and sACN carry unauthenticated packets.

| Offset from first channel | Control |
| --- | --- |
| 0 | Native video brightness. 128 is neutral |
| 1 | Native video hue. 128 is neutral |
| 2 | Native video saturation. 128 is neutral |
| 3 | Media slot. 0 is the built-in presentation. Assign slots 1–255 in the console |
| 4 | 0–31 idle, 32–63 play the slot, 64–95 stop, 96–127 restart, 128–159 blackout |

Return transport to idle before the first cue and between repeated cues. A held cue does one operation. After 2.5 seconds without a valid packet, colour returns to neutral and transport waits for idle again. A group slot uses the same media readiness checks as the browser. The colour controls affect the native video image on the local player. [Art-Net specification](https://art-net.org.uk/structure/streaming-packets/artdmx-packet-definition/) · [ANSI E1.31](https://tsp.esta.org/tsp/documents/docs/ANSI_E1-31-2018.pdf)

Player A verified both transports on BrightSignOS 9.1.82. The installed firmware rejected native picture adjustment at 4K50. The API returns the rejection and transport remains available. See the [hardware evidence](API_VERIFICATION.md#management-suite--brightsignos-9182).

## API v1

Use HTTPS Basic authentication with the same installation login. State-changing requests require `X-SyncPlayer-Request: control` and browser calls must originate from the interface. Use `Content-Type: application/json` for JSON bodies. An optional `Idempotency-Key` on device commands and deletion replays the prior result during the current process. Use a fresh key for each new command. Administrative access and peer access use distinct credentials.

| Method and path below `/api/v1` | Body or purpose |
| --- | --- |
| `GET /status` | Native state, standby, peer reports, free storage, PTP observations and recent activity |
| `GET /playback` | Latest one-second decoder position with state and transport availability |
| `GET /players` | Player addresses and current reports |
| `PUT /group/members/{id}` | `{"included":false}` removes a provisioned follower. Use `true` to add it back |
| `GET /content` | Draft and complete revision summaries |
| `PUT /uploads?name=Welcome_A.mp4&replace=0` | Raw `application/octet-stream` body with `Content-Length`. Set `replace=1` to replace an existing draft clip |
| `POST /distribute` | `{"id":"...","revision":"..."}` or `{"clear":true}` |
| `GET /jobs/distribution` | Current assigned revision and each player's report |
| `POST /play` | `{"id":"presentation"}`, or uploaded set `id` and optional `revision`. Add `"preview":true` for local playback |
| `POST /pause`, `/resume` | `{}` |
| `POST /seek` | `{"positionMs":30000}` during local or group MP4 playback. On a follower, the request passes to the leader. A group jump starts playback at the requested position. |
| `POST /stop`, `/restart`, `/blackout` | `{}` |
| `POST /loop` | `{"enabled":true}` |
| `POST /source` | `{"type":"web","url":"https://server/page.html"}` or `type: srt` with an SRT URL |
| `GET /settings`, `PUT /settings` | Current state or a partial settings update |
| `GET /ptp` | Multicast listener state and recently heard domains |
| `PUT /colour` | `{"brightness":0,"hue":0,"saturation":0}`. Each value is an integer −1000 to 1000 |
| `GET /lighting`, `PUT /lighting` | Current lighting settings or `{"protocol":"sacn","source":"192.168.1.50","universe":1,"channel":1}`. Use `"protocol":"off"` to close the listener |
| `PUT /lighting/slots` | `{"slot":1,"id":"...","revision":"..."}`. Pass an empty `id` to clear a slot |
| `GET /clock`, `PUT /clock` | Live RTC or `{"utc":"2026-11-26T08:00:00.000Z"}` or `{"sydney":"2026-11-26T19:00"}` |
| `POST /display-power` | Send `{"power":"on"}` or `{"power":"standby"}` to the local HDMI-CEC interface |
| `PUT /group/audio/B` | Send `{"enabled":true}` or `{"enabled":false}` on the leader to select HDMI audio for Player B |
| `POST /snapshot` | Send `{}` to capture a 960 × 540 JPEG |
| `GET /updates` | Read the running version, staged version and GitHub source |
| `DELETE /content/{id}/{revision}` | `{"confirm":true}`. Use `draft` as the revision for a draft |

`PUT /settings` accepts `volume` (0–100), `muted` (Boolean), `audioenabled` (Boolean), `output` (`3840x2160x50p` or `1920x1080x50p`), `rotation` (0, 90, 180 or 270), `ntp`, `interval` (0 or 120–86400), `on` and `off` (Sydney `HH:MM`), `scheduleenabled` (Boolean), `role`, `leader`, `domain` (0–127), `group`, `rect` (`x`, `y`, `width`, `height` as percentages) and `overlay` (URL, or an empty string to clear). Output, rotation and role changes return an acknowledgement before the restart. Read `/status` afterwards for the applied state.

The Players panel compares native decoder reports from the same playback cycle. During playback, the console estimates the position difference using the time each report arrived at the leader. During pause, it compares the stopped positions directly. Physical HDMI frame alignment requires an output measurement.

From a workstation, use the specific player's public `clock-cert.pem` for HTTPS verification. These examples prompt for the installation password.

```powershell
curl.exe --cacert clock-cert.pem --user SyncPlayer https://192.168.1.11:8080/api/v1/status
curl.exe --cacert clock-cert.pem --user SyncPlayer -X POST -H 'X-SyncPlayer-Request: control' -H 'Content-Type: application/json' --data '{}' https://192.168.1.11:8080/api/v1/restart
```

## SD updates and rollback

Use `tools/stage_suite.py` on the prepared presentation folders to create the small update archive. Restore or copy each card's private `clock/credentials.json`, `clock/clock-key.pem`, `clock/clock-cert.pem` and `clock/peer-credentials.json` separately. Generate a consistent group using `--provision` when creating a private set from prepared cards with local password files. Keep `media/` and `library/` during upgrades. The native settings are stored in registry section `StartSyncPlayerSuite`. Keep a copy of the previous scripts, version and web files before replacing the update. The shared ZIP excludes credentials and content.
