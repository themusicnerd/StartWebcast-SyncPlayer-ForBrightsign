# StartWebcast SyncPlayer operator guide

**Group Membership** on the leader lists the current roster. **Add Player** re-admits a provisioned follower. A new physical player needs its card identity and peer credentials before it appears in the selector.

**Clock & Schedule** saves the Sydney wake and standby times. Playback and overlays continue while the schedule controls HDMI-CEC display power. Clear **Enable Display Schedule** and save to use manual display power. Followers use the leader’s display schedule in group mode.

The top bar shows HDMI-reported TV power. **Power On** and **Standby** send local HDMI-CEC commands to the connected display. **Snapshot** captures a 960 × 540 JPEG of the player’s video and graphics output. A snapshot can show content while a television is off, and HDMI adapters or displays can report power differently. [BrightSign HDMI and Screenshot API](https://docs.brightsign.biz/develop/rovideomode) · [BrightSign HDMI-CEC API](https://docs.brightsign.biz/develop/rocecinterface)

**Updates** accepts signed packages from the operator’s computer or a configurable GitHub branch. [App Update Guide](UPDATES.md)

**Media Library** lists the presentation already on the SD card and any media you upload. The generated **Sync Test** clips include a frame counter and a short tone for each second. [Sync Test Clips](../test-content)

At startup the player restores the last saved source. MP4s start at the beginning. A saved SRT feed or webpage opens on the player that selected it. The player retries an unavailable live source. Stop and Blackout are saved startup states. Local previews apply to the current session. A group library selection waits for the matching media on its followers.

Select **Follow Group** to return a follower from its local live source to group playback. The follower joins the latest active group cue when available.

Set **Output Rotation** in **HDMI & Audio**. Select 0°, 90°, 180° or 270° clockwise for each player. Save the setting to restart that player. The video and graphics layers rotate together, and the layout window follows the rotated coordinates. [Video Rotation API](https://docs.brightsign.biz/develop/rovideoplayer) · [HTML Widget Rotation](https://docs.brightsign.biz/develop/rohtmlwidget)

All players use HDMI audio by default. Use **Enable Audio** or **Disable Audio** in **Group Membership** on the leader to select any combination of players. In **HDMI & Audio**, set the local audio, volume or mute. The group audio state displays Pending until the follower acknowledges the change.

Open **Help** in the top bar for offline console procedures and API examples. The instructions follow ASD-STE100 style with short commands in operating order. [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)

Use HTTPS on port 8080 from the management LAN. The prepared addresses are `192.168.1.11`, `192.168.1.12` and `192.168.1.13`. Sign in with the installation credentials. The BrightSign diagnostics server uses its own HTTPS address on port 443. The bundled interface and local library work without internet access.

## Playback and media

- **Play Presentation** returns to the presentation on the card. **Stop** clears the video and shows the holding image. **Blackout** hides both layers. **Restart** restarts the selected source. **Loop** controls repeat playback of a local MP4. The schedule sends display power commands while playback continues.
- The playhead shows the native playback position once per second. **Pause** becomes **Resume** after a pause. Drag or use the keyboard to move the playhead. During group playback, use any included player to start the group at the selected position. Group controls become available when the included followers report the same clip and playback state. [BrightSign Video Transport](https://docs.brightsign.biz/develop/rovideoplayer)
- In **Lower Layer Media Library**, select or drop an MP4 for each member. Use one shared title followed by a player suffix. For example, use `Welcome_A.mp4`, `Welcome-B.mp4` and `Welcome.C.mp4`. Check the detected assignments and select **Upload**. The leader verifies the media and retains earlier complete revisions.
- **Preview on this player** plays the leader's file locally. **Distribute** publishes a complete revision to the configured followers. Followers download their matching file and verify its size, SHA-256 and native playability. **Play group** requires fresh reports from every follower that confirm the same revision, group, PTP domain and HDMI mode. Timing uses native SyncManager. A reconnecting follower can start on a subsequent native transition. The console reports reachability and readiness separately from measured sync quality.
- In **Standalone**, upload the file for the local player and choose **Play on this player**. The local selection is saved and the player runs without a SyncManager session.
- Select **Delete Set** to remove an uploaded set with all its drafts and revisions. Select **Delete Draft** or **Delete Revision** to remove one item. Select another source and clear the active distribution before deleting media in use.
- The SD presentation lists the media properties for each screen. Select **Play Group** to play the ABC set or **Preview on This Player** to play its local file. **Delete From Library** removes the entry and keeps its original SD files. Select **Restore SD Presentation** to show the entry again. Select a different active and startup source before removing the entry.
- The player starts the last selected source after a reboot. Use **Stop** to stop playback for the current session.

## Group membership

Use **Group membership** on the leader to add or remove a provisioned follower. The leader keeps its place in the group. Membership applies to media requirements, distribution, and group transport. An updated follower stops group playback after receiving its exclusion on an authenticated heartbeat. Re-added followers can prepare their files and join on a subsequent native start. Update the followers to 0.2.4 before relying on remote exclusion or group Pause and Resume. To introduce an address or player ID to the installation, commission its card and peer credentials first.

## Lower and upper layers

The **Lower Layer** displays one base source. Select **Play Presentation**, choose an MP4 in **Lower Layer Media Library**, or enter a URL in **Add or Play a Source**. Use **Play URL** for a one-off source. To keep the source on this player, enter a name and select **Save Source**. Choose a saved source and select **Play Selected**. Use **Position and Size** to change the lower-layer window. Live sources use their own timing and the player restores the last accepted source at boot.

Choose a saved source and select **Edit** to change its name, type or URL. Leave the URL blank to keep it when the type stays the same.

In **RTSP & SRT Recovery**, choose **Keep Retrying the Stream** or select a local library clip and save. The player waits between repeated connection attempts. With a fallback configured, a third failed attempt switches to the selected clip. Select **Retry Last Stream** to try the saved stream again. The player tries the saved stream again at startup.

The **Upper Layer** displays a full-screen HTML5 overlay above the lower layer for the current session. Use a transparent page background to show the lower layer through the overlay. **Display Layout** shows the lower-layer window and the overlay outline. A lower webpage and an overlay share one Chromium widget. Both webpages must allow framing. Web content uses standard browser security and has no hardware or Node privileges.

**Display Preview** shows a low-resolution capture of the HDMI output. When the overlay is active, the capture includes both layers. The **Players** panel shows the same type of image for online group members. Select **Edit Layout** to place players in up to three rows and columns. Save the layout from any admitted console. [BrightSign Screenshot API](https://docs.brightsign.biz/develop/rovideomode)

For SRT, use `srt://encoder:port?mode=caller` from a compatible encoder in listener mode, or `srt://0.0.0.0:port?mode=listener` when the encoder initiates the connection. The native SRT source depends on the installed BrightSignOS build or SRT extension. Read the Playback status for a reported start or timeout. Test the actual feed and provider profile before use. [BrightSign SRT support](https://support.brightsign.biz/hc/en-us/community/posts/360038334993-SRT-Secure-Reliable-Transport)

For RTSP, use the URL supplied by the camera or encoder, such as `rtsp://camera:554/live`. Use the stream’s H.264 or H.265 profile supported by the XD236. [BrightSign streaming content](https://docs.brightsign.biz/develop/content-sources)

## Settings

- **HDMI & Audio** changes the selected player between 4K50 and 1080p50 and sets native MP4 and stream volume. Grouped players use matching output modes. Select **CEC Remote Playback** to accept Play, Pause and Stop from a compatible TV. An in-group follower passes the commands to the leader.
- **Ethernet** shows the active address and MAC. Use **Static** to enter the IPv4 address, mask, gateway and DNS servers. Use **DHCP** to take the settings from your network. Reserve the configured IP for a grouped player. A standalone player can use a different address. Read the new address on its identification screen after restart.
- Under **Settings → Startup**, clear **Show IDENT on Boot** to start with a black screen until playback begins. This skips the automatic IDENT screen and the holding image. The setting defaults to on. Changes apply at the next boot. Use the top-bar **IDENT** button at any time.
- **Device Status** shows local CPU, RAM, SD capacity, temperatures and screen identification from HDMI EDID where available. **IDENT** shows player information, address, settings, clock and lighting configuration over the current output. Select **IDENT** again to hide it.
- **Test Pattern** shows offline colour bars and the player name. Select **Test Pattern** again to hide it. Playback continues underneath.
- **Updates** shows the installed BrightSignOS version. Open the BrightSign updater, sign in to the Diagnostic Web Server, then select **Advanced** and **BrightSignOS Update**. [BrightSign DWS](https://docs.brightsign.biz/manage/diagnostic-web-server-dws)
- **Playback mode & PTP** selects Leader, Follower or Standalone. Followers must select the new leader explicitly. Apply the same group name and IEEE 1588 domain to all group members. Change the old leader to a follower as part of a planned handover. Role and domain changes restart the affected player. The console lists domains reported by configured players and IPv4 multicast announcements the optional receive-only listener hears on the local interface. Other VLANs, profiles and unicast timing may be invisible.
- **Request HDMI Genlock** is off by default and applies to the selected player in a group. Changing it restarts the player. **Requested · Lock Unverified** means the firmware accepted the request. **Request Rejected · PTP Still Enabled** means playback continues using native PTP. BrightSign documents lock-state readback on XC5 and XT5. [BrightSign video mode API](https://docs.brightsign.biz/develop/rovideomode#set-sync-domain)
- **Clock & Schedule** displays Sydney time, sets the hardware clock and changes the daily display wake and standby times. A large clock change can briefly restart playback. **Network Time** accepts an SNTP-compatible hostname or IPv4 address and the polling interval. The factory default is `0.au.pool.ntp.org`. Clear the hostname to disable network time. Use 0 for the vendor default interval. NTP maintains wall clock time. Native PTP supplies group playback timing.


Use the rotate button on a player preview to turn the preview clockwise by 90°. The group saves the angle by player, including when you rearrange the grid. A quarter-turn displays the preview in a 9:16 frame.

### Display Control

Open **Device Settings → Display Control** on the player connected to the display. Save the selected mode. The top-bar **Power On** and **Standby** buttons and the display schedule use that mode. HDMI-CEC is the default. The schedule keeps playback running.

- **Samsung IP Control** sends both commands to the TV over the LAN. **CEC Wake / Samsung IP Standby** uses HDMI to wake the TV and the LAN to turn it off. Use the hybrid mode if the Samsung IP service goes offline in standby.
- On a Samsung TV, open **All Settings → Connections → Network → Expert Settings**. Enable **Power On with Mobile** and **IP Remote**. Enter the TV’s address in SyncPlayer and save. Use port 1516 on current models. Select **Pair Samsung TV** with the TV awake and approve the prompt on the TV. SyncPlayer saves the token and the TV certificate fingerprint locally. Pair again if the certificate changes. Test both buttons before depending on the schedule. [Samsung Consumer IP Control Worksheet](https://image-us.samsung.com/SamsungUS/samsungbusiness/tv-ci-resources/Samsung-IP-Control.pdf)
- **Sony BRAVIA Simple IP** sends discrete power commands to compatible BRAVIA displays. Enable Simple IP Control. The default is TCP 20060.
- **TCL / Hisense Roku TV** sends standby through Roku ECP on port 8060 and uses HDMI-CEC to wake. Enable Control by Mobile Apps on the Roku TV. Other TCL and Hisense platforms can use CEC or a model-specific custom TCP or UDP profile.
- **Sharp AQUOS IP** sends discrete power commands to compatible AQUOS models that allow IP control with no login credentials. The default is TCP 10002. Enable IP wake on the display if supported.
- **PJLink** sends power commands to compatible NEC, Sharp, Panasonic and other displays or projectors. The default is TCP 4352. SyncPlayer supports the no-password and legacy MD5 authentication modes. Test wake from standby on the display.
- **Custom TCP** and **Custom UDP** use a fixed private IPv4 address and port. Set the two payloads in **Power Commands**. **Hex** sends exact bytes. Include `0D 0A` if the display protocol requires CRLF. **UTF-8 Text** sends the entered characters with no added terminator. **Send One-Off Command** uses the saved destination and accepts its own format and payload. A sent command confirms transport only. Check the actual display response.

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
| `POST /source` | `{"type":"rtsp","url":"rtsp://camera:554/live"}`. Also accepts `srt` and `web`. Use `{"id":"..."}` to select a saved source. |
| `GET /sources`, `POST /sources` | List local saved sources, or add one with `{"name":"Camera","type":"rtsp","url":"rtsp://camera:554/live"}`. |
| `PUT /sources/{id}` | Change the name, type or URL. Omit the URL or send an empty string to keep the saved URL. |
| `DELETE /sources/{id}` | Send `{}` to remove the saved entry. |
| `GET /stream-recovery`, `PUT /stream-recovery` | Read available fallback IDs. Send `{"fallback":"presentation"}` to use the SD presentation or `{"fallback":""}` to keep retrying. |
| `POST /retry-stream` | Send `{}` to try the last selected SRT or RTSP stream again. |
| `GET /display-control` | Read the active mode, pairing status and last command result. |
| `PUT /preview-rotation` | Send `{"player":"B","rotation":90}` to save a local preview angle across the group. Output rotation is a separate setting. |
| `PUT /display-control` | Save `{"mode":"cec"}`, `{"mode":"hybrid","address":"192.168.1.50","port":1516}`, or a `samsung`, `sony`, `roku`, `sharp`, `pjlink`, `tcp`, or `udp` profile. Use `password` for PJLink authentication. Omit it to keep the saved password for the same destination or send an empty string to clear it. For TCP and UDP, add `format` (`hex` or `text`), `on` and `standby` payload strings. |
| `POST /display-control/pair` | Send `{}` and approve the Samsung TV prompt. |
| `POST /display-power` | Send `{"power":"on"}` or `{"power":"standby"}`. Add `"via":"cec"` for a one-time CEC command. |
| `POST /display-command` | Send a one-off payload to the saved TCP or UDP destination. Example `{"format":"hex","payload":"50 4F 46 46 0D 0A"}`. |
| `POST /ident` | Send `{}` for 10 seconds of IDENT or `{"mode":"test-pattern"}` for local colour bars. Use `seconds` to set a duration up to 30 seconds for IDENT or 600 seconds for Test Pattern. Send `{"seconds":0}` to close either. |
| `PUT /player-layout` | `{"rows":1,"columns":3,"cells":["A","B","C"]}`. Use `null` for an empty cell. |
| `POST /preview` | Request new thumbnails with `{}`. Read each thumbnail epoch from `/status`. |
| `GET /players/{id}/preview?v={epoch}` | Read the corresponding 160 × 90 JPEG. |
| `GET /network`, `PUT /network` | Read the active Ethernet profile. Apply `{"mode":"static","address":"192.168.1.11","netmask":"255.255.255.0","gateway":"","dns":[],"confirm":true}` or use `mode: dhcp`. Group DHCP also requires `"reserved":true`. |
| `GET /settings`, `PUT /settings` | Current state or a partial settings update |
| `PUT /settings` with `{"identonboot":false}` | Keep the screen black at the next boot until playback begins. Use `true` to enable it. |
| `PUT /settings` with `{"genlock":true}` | Request HDMI genlock on this group player and restart. Read `native.genlockstate` in `/status` to see the request result. |
| `GET /ptp` | Multicast listener state and recently heard domains |
| `PUT /colour` | `{"brightness":0,"hue":0,"saturation":0}`. Each value is an integer −1000 to 1000 |
| `GET /lighting`, `PUT /lighting` | Current lighting settings or `{"protocol":"sacn","source":"192.168.1.50","universe":1,"channel":1}`. Use `"protocol":"off"` to close the listener |
| `PUT /lighting/slots` | `{"slot":1,"id":"...","revision":"..."}`. Pass an empty `id` to clear a slot |
| `GET /clock`, `PUT /clock` | Live RTC or `{"utc":"2026-11-26T08:00:00.000Z"}` or `{"sydney":"2026-11-26T19:00"}` |
| `PUT /group/audio/B` | Send `{"enabled":true}` or `{"enabled":false}` on the leader to select HDMI audio for Player B |
| `POST /snapshot` | Send `{}` to capture a 960 × 540 JPEG |
| `GET /updates` | Read the running version, staged version and GitHub source |
| `POST /follow` | Send `{}` to return a follower from its local live source to group playback |
| `DELETE /content/{id}/{revision}` | `{"confirm":true}`. Use `draft` to remove a draft or `all` to remove the full uploaded set. |
| `DELETE /content/presentation`, `PUT /content/presentation` | Send `{"confirm":true}` to remove or restore the SD presentation entry. |

`PUT /settings` accepts `volume` (0–100), `muted` (Boolean), `audioenabled` (Boolean), `output` (`3840x2160x50p` or `1920x1080x50p`), `rotation` (0, 90, 180 or 270), `ntp`, `interval` (0 or 120–86400), `on` and `off` (Sydney `HH:MM`), `scheduleenabled` (Boolean), `role`, `leader`, `domain` (0–127), `group`, `rect` (`x`, `y`, `width`, `height` as percentages) and `overlay` (URL, or an empty string to clear). Output, rotation and role changes return an acknowledgement before the restart. Read `/status` afterwards for the applied state.

The Players panel compares native decoder reports from the same playback cycle. During playback, the console estimates the position difference using the time each report arrived at the leader. During pause, it compares the stopped positions directly. All consoles show the same group reports and each player's difference from the leader. Physical HDMI frame alignment requires an output measurement.

From a workstation, use the specific player's public `clock-cert.pem` for HTTPS verification. These examples prompt for the installation password.

```powershell
curl.exe --cacert clock-cert.pem --user SyncPlayer https://192.168.1.11:8080/api/v1/status
curl.exe --cacert clock-cert.pem --user SyncPlayer -X POST -H 'X-SyncPlayer-Request: control' -H 'Content-Type: application/json' --data '{}' https://192.168.1.11:8080/api/v1/restart
```

## SD updates and rollback

Use `tools/stage_suite.py` on the prepared presentation folders to create the small update archive. Restore or copy each card's private `clock/credentials.json`, `clock/clock-key.pem`, `clock/clock-cert.pem` and `clock/peer-credentials.json` separately. Generate a consistent group using `--provision` when creating a private set from prepared cards with local password files. Keep `media/` and `library/` during upgrades. The native settings are stored in registry section `StartSyncPlayerSuite`. Keep a copy of the previous scripts, version and web files before replacing the update. The shared ZIP excludes credentials and content.
