# Sync Test Content

The three generated MP4 files each contain 750 frames at 1920 × 1080 and 25 fps. Each player has a label and a different background colour. A white bar and short stereo tone mark each second.

1. Open **Media Library** on the leader.
2. Upload the three `Sync Test` files together.
3. Select **Distribute** on the **Sync Test** revision.
4. Wait for the group to verify the files.
5. Select **Play Group**.
6. Compare the frame numbers and the white bar on each display.

Use the playhead to move all included players to the same point. Use **Play Presentation** to return to your presentation.

To regenerate these files, run `python tools/build_release.py --test-content --output test-content` with FFmpeg and FFprobe installed.
