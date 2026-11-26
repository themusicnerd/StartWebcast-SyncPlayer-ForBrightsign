# Install SyncPlayer From microSD

1. Extract the release ZIP on a workstation.
2. On an isolated bench or a network where the addresses are free, use Player A at `192.168.1.11`, B at `192.168.1.12` and C at `192.168.1.13`. A is the leader for the included Sync Test. Set the card IP assignments before provisioning if your network uses different addresses.
3. To commission web access on new cards, add your installation password in `dws-password.txt` in each extracted Player folder. In a checkout of the matching release, run the following command with Python and OpenSSL installed. Keep the resulting files private.

   ```powershell
   python tools/stage_suite.py --cards "C:/path/to/extracted-zip" --provision --update-key updates/update-trust.pem
   ```

4. Copy the **contents** of the matching Player folder to the root of its FAT32 or exFAT microSD card. Insert the card and power on the player. The included test media gives you a source for the A/B/C group.
5. Open the SyncPlayer console at HTTPS port 8080. Use `SyncPlayer` and the password you provisioned. Open **Updates → GitHub Source** to fetch and stage signed application updates from the public repository.

For an existing installation, use the signed `.swu` update to keep its provisioned media and settings. The full install ZIP contains generated test media.
