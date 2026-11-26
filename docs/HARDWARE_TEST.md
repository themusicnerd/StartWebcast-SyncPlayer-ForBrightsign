# XD236 hardware bench checklist

**Status** Pending real-device testing. These runs exercise the first milestone and inform production tests H05, H06, H08 and H10. Browser commissioning, upload, group controls and other production acceptance remain future milestones.

## Set up and record

- Follow the [SD quick start](SD-QUICK-START.md) using three spare cards. Record the ZIP SHA-256, the config actually used, each player's ID, BrightSignOS, serial, card capacity and filesystem, switch model/VLAN, display model, HDMI mode and capture equipment.
- Use the same wired VLAN with multicast forwarding for SyncManager (`224.0.126.10:1539/UDP`) and PTP. Leave the secondary interface disconnected. Verify the proposed domain 15 is appropriate on the bench. Capture PTP and SyncManager traffic from an authorised mirror port if timing fails. BrightSign identifies IGMP snooping and unknown multicast filtering as possible causes of disagreement during playback. [BrightSign switch guidance](https://docs.brightsign.biz/technical/sync-network-and-switch-settings)
- If local DWS already exists, use its Log tab or the authorised local debug console to collect the app records and errors. If local diagnostics are disabled, follow [BrightSign's local access instructions](https://docs.brightsign.biz/manage/diagnostic-web-server-dws) for dedicated bench units. The app sends structured records to the vendor system log with vendor-managed retention. Export the relevant interval early in long runs. Keep credentials and unrelated registry values out of shared evidence.
- Before changing PTP or output mode, record each player's prior `networking/ptp_domain`, `networking/ptp_interface` and video mode for rollback. Record whether each PTP key was present. The app logs previous PTP values when opt-in setup runs.

## Measure the outputs

Use a shared-clock three-input HDMI capture where available, or put all three displays in one shot on a high-speed camera (240 fps or faster). Match display processing modes and account for display latency and rolling shutter. Align observations by shared capture time or camera frame. Read each six-digit counter. At a wrap compute the shortest difference modulo 600, and score missing, held or black frames separately. The target is the same source frame, with at most one frame discrepancy during steady state. Record sample count, maximum A/B, A/C and B/C difference, overshoot count, and duration. Report startup and each transition separately. Camera footage cannot establish HDMI electrical phase.

| Check | Procedure and evidence |
| --- | --- |
| M1-01 · Boot | Boot B, C then A. Record board and firmware, any PTP reboot or HDMI mode restart, role logs and accepted native play requests. Confirm the displayed A/B/C labels. Disconnect the bench uplink and repeat to confirm offline behaviour. |
| M1-02 · Frame alignment | Capture all three outputs once steady for at least 60 seconds, including a loop boundary. Record mismatch samples and check the proposed threshold. Report both the capture method and any displays involved. |
| M1-03 · Loop and endurance | In seamless mode capture consecutive 599 → 0 transitions. Record gap length, held/blank frames and mismatches. Run eight hours and observe at least 100 transitions, with capture and log samples across the run. If native seamless ends, record `SEAMLESS_MEDIA_ENDED` and mark seamless as failed. Repeat in `reschedule` mode on all three as a separate measurement. Its 500 ms native scheduling lead time starts at leader media end. |
| M1-04 · Late join | Power-cycle B during playback and repeat with C, including a restart near wrap. Measure return to valid output and steady alignment. Note any interruption or restart on healthy screens. |
| M1-05 · Link and leader loss | Disconnect and reconnect B's Ethernet in steady play. Then power-cycle A. Record whether followers hold, drift, stop or recover, and how long native rejoin takes. Repeat after a whole-group power cycle. Capture the first post-recovery transition. |
| M1-06 · Wrong setup | On a spare test card use an unmapped IP, missing local clip and a PTP mismatch without opt-in, one fault at a time. Verify blank output and the appropriate fault log. Restore the correct setup after each test. |
| M1-07 · Optional Genlock | Change `enable_genlock` to true on all three cards and reboot. Record the accepted or rejected request. Use compatible measurement equipment to measure HDMI phase independently from the counter comparison. |

For each row record date, procedure and config, artefact paths, expected and observed result, pass/fail/pending, and any reproduction steps for a fault. Save the simultaneous capture and redacted log excerpt beside the results. Keep boot, playback event timestamps and external capture time distinct.

## Roll back

Power off each player and remove the spare test card. Reinstall the original card. If the bench changed a PTP key, restore its previous value or remove that key if previously absent using the approved player registry tooling, then reboot. If the previous presentation leaves the bench HDMI mode in place, restore the recorded prior mode through the player's approved display configuration. Check the original presentation after boot. [BrightSign DWS registry and display controls](https://docs.brightsign.biz/manage/diagnostic-web-server-dws)
