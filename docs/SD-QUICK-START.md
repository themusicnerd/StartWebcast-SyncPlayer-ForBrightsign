# Start SyncPlayer · XD236 bench

Use three spare FAT32 microSD cards and three XD236s on the same wired bench switch. Keep existing media cards for rollback. Use matching BrightSignOS and three displays that accept 1080p60. The documented reference build is **BrightSignOS 9.1.173**. Record the version actually installed on each player.

1. Set these addresses on the XD236s' **rear LAN / PoE port** (`eth0`). Static addressing or DHCP reservations both work. Use the same subnet and leave the front Control ports disconnected.

   | Screen | Role | IPv4 |
   | --- | --- | --- |
   | A | Leader | `192.168.1.11` |
   | B | Follower | `192.168.1.12` |
   | C | Follower | `192.168.1.13` |

2. Extract the same ZIP directly into the root of all three cards. Check that `autorun.brs`, `syncplayer.json` and the `media` directory sit at the root.
3. Enable player PTP on wired Ethernet, domain **15**. If it is already configured and the players have rebooted since the change, leave the config as supplied. For a dedicated bench, you can set `"apply_ptp_settings": true` in each card's `syncplayer.json` to let the app configure PTP and reboot the player once if needed. Record the previous registry values before doing this if they must be restored later. Editing the config changes its archive checksum. The app reads the IPs in step 1 as assigned by the network.
4. Insert the cards while the players are off. Boot B and C first, then A. The first boot can include a restart for PTP or the HDMI mode. A allows 10 seconds for the clock service after native setup and then requests the first synchronised start. Screens should display their own letter and repeat a 10-second counter, `000000` through `000599`.
5. Film all three displays together or use a shared-clock HDMI capture to check the counters. Power-cycle B while A and C play. Record how long B takes to show the correct frame sequence and whether A or C is interrupted.

The application starts automatically and has no browser setup or login. If local BrightSign diagnostics are already available, use the DWS Log tab and filter for `"app":"Start SyncPlayer"`. Look for `ROLE_ASSIGNED`, `NATIVE_READY` and `NATIVE_PLAY_REQUESTED` on each unit. A play request is evidence of a decoder request. Frame alignment requires capture.

If a display stays blank, check the rear Ethernet port and assigned IP, PTP configuration and logs first. `ETH0_ADDRESS_UNASSIGNED` indicates no link with a mapped address within 45 seconds. `PTP_SETUP_REQUIRED` indicates a registry mismatch. `LOCAL_CLIP_UNPLAYABLE` indicates that the on-device video probe rejected the clip. `SEAMLESS_MEDIA_ENDED` indicates that the native seamless attempt ended. To test a measured restart on each loop instead, change `"loop_mode"` to `"reschedule"` on **every** card, reboot all units and record it as a separate test. The leader requests each restart 500 ms after its clip ends. For the full bench procedure, see `docs/HARDWARE_TEST.md` in the source repository.
