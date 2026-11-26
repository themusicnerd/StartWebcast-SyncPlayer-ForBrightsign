# Prepared XD236 content cards

Use three spare FAT32 microSD cards with at least 3.2 GB free on each.

1. Copy the **contents** of `sdcard/PlayerA`, `sdcard/PlayerB` and `sdcard/PlayerC` to their respective cards. On each card, `autorun.brs`, `playback.brs`, `syncplayer.json` and the `media` folder go at the root.
2. Connect the rear LAN ports to the same wired switch. Each card sets the rear Ethernet interface to its own static IPv4 address on first boot and confirms it before continuing. A uses `192.168.1.11`, B uses `192.168.1.12` and C uses `192.168.1.13`, all with mask `255.255.255.0`. Keep these addresses clear of other devices and DHCP allocations. The card writes the result to `network-setup.txt` and keeps a per-player commissioning marker.
3. Connect displays that accept 4K at 50 Hz. Insert the cards with the players off. Boot B and C, then A. Initial setup can include a reboot for wired PTP domain 15 and a restart to set the HDMI mode. Record the previous PTP and HDMI settings if you need them for rollback.
4. Enable HDMI-CEC on each display and keep the BrightSign players powered. Each day, Player A requests display wake at 07:00 and standby at 21:00 Sydney time, including weekends and daylight saving. The holding image is placed behind the video plane during wake. A allows a short clock settle then schedules playback automatically. Audio comes from A over HDMI. A schedules the next synced start after each run. Measure the gap at the loop boundary on hardware.

If the cards already have the presentation, copy the files inside the matching folder from the small SD update ZIP to the card root. The update contains `autorun.brs`, `playback.brs`, `syncplayer.json`, `VERSION` and `SHA256SUMS`, plus the `clock` application files on the leader. The existing `media` folder supplies the movie and holding image. The schedule uses Player A’s real-time clock, so its date and time need to be valid. You can change the on/off times in the `display_schedule` section of the same configuration on all three cards.

For an HD setup, change `output_mode` to `1920x1080x50p` on all three cards. Editing a file changes its recorded SHA-256. The supplied config targets `3840x2160x50p`.

If the address does not change, check `network-setup.txt` on that card. If playback stays on the holding image, check the LAN addresses, Player A's clock and which card went into each unit. When local diagnostics are available, look for `WRONG_PLAYER_CARD`, `LOCAL_CLIP_UNPLAYABLE`, `OUTPUT_MODE_REJECTED`, `NATIVE_READY` and `NATIVE_PLAY_REQUESTED`. Use the [hardware checklist](HARDWARE_TEST.md) to measure frame alignment and recovery.

## Local diagnostics on the same card

Put the installation password on one line in `dws-password.txt` at the card root. The launcher checks the password format, configures the BrightSign owner's local diagnostics with digest authentication, and restarts once to enable the service. BrightSign uses the username `admin`. The launcher preserves existing DWS credentials when diagnostics already exist. Save the password securely and remove the setup text file from the card after diagnostics work. Keep password files separate from shared ZIPs and source control. [BrightSign local diagnostics setup](https://docs.brightsign.biz/manage/dws-local-access)

On the trusted LAN, open the player's IP in an HTTPS browser. If the requested static address has not taken effect, check the last responding address. The startup script writes `boot-report.txt` before launching `playback.brs`. This report gives the last completed stage even when video startup fails. `network-setup.txt` records the result of an IPv4 commissioning attempt.

## Web console and clock

The StartWebcast SyncPlayer console runs at each provisioned player's HTTPS address on port 8080. On this installation the original leader is [192.168.1.11:8080](https://192.168.1.11:8080/). Sign in as `SyncPlayer` with the installation password. Use **Use this computer’s time** for a quick set or enter a date and time manually in Sydney time. During the repeated hour when daylight saving ends, use the computer clock to give the player an unambiguous time. The console reads the clock back after each set. The player applies the daily display schedule using the updated time. A clock correction can briefly restart playback. Followers receive the leader’s display commands through SyncManager. See the [operator guide](SUITE.md) for playback, sources, settings and the API.

The prepared player folders carry their private provisioning files in `clock`. Use `python tools/stage_suite.py --provision` to generate private web credentials and a consistent peer group using OpenSSL and the local installation password files. Keep each card's TLS key, password verifier and peer configuration on that card. The HTTPS server binds to the player's configured LAN address. If the browser asks you to verify the self-signed certificate, compare it with `clock-cert.pem` on the prepared card. You can also supply a certificate issued by your organisation for the player's IP.

## Media verification

For the prepared cards, FFmpeg fully decoded all three source movies, including their audio tracks, without errors. Each has 12,626 video frames at 25 fps over 505.04 seconds. Audio packet timing matched across the set. Each prepared movie matched the source bytes. Player A played its original MP4 at 4K50 output. Loop gaps, display behaviour and frame alignment are pending a three-player hardware check.

## Preparing another set

From the repository, run `python tools/prepare_sdcards.py SHARED_STEM --output path/to/empty/folder`. The builder reads the matching A, B and C MP4s and the HOLDING JPEG from `content`. It checks the 4K25 video and audio timelines, preserves each MP4 byte-for-byte, and makes a 1920 × 1080 playback copy of the holding image. Each build has a native group ID derived from its video hashes.

[BrightSign media formats](https://docs.brightsign.biz/technical/video-formats-and-codecs) · [BrightSign image limits](https://docs.brightsign.biz/technical/image-formats) · [Native sync architecture](https://docs.brightsign.biz/technical/video-wall-sync-architecture)

Static IPv4 settings persist on the player. To return a player to DHCP, remove the static-IP card configuration and use the player's network setup to restore DHCP on the rear Ethernet interface.
