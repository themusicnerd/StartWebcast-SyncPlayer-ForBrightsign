# SyncPlayer App Updates

Install version 0.2.5 or later on the SD card to enable app updates. The card needs the signing public key at `clock/update-trust.pem`. The media, credentials, device settings and BrightSignOS firmware stay on the card outside the update slots.

## Install an Update

1. Open **Updates** on the player.
2. Choose **Stage File** for a signed `.swu`, or set the GitHub repository as `owner/repository` and enter the branch. Select **Fetch and Stage** to download on the player or **Fetch Using Browser** if only your computer can reach GitHub.
3. For a private repository, enter a read-only GitHub token with repository Contents access. The console uses it for that download and discards it afterward. [GitHub Contents Permissions](https://docs.github.com/en/rest/repos/contents#get-repository-content)
4. Check the staged version and select **Install and Restart**. The console and playback will be briefly unavailable on that player. Verify that the running version changed before moving to the next player.
5. Select **Roll Back and Restart** to go back to the previous version. If the new slot fails its startup check, the player attempts to boot the previous healthy version.

The default GitHub source is `themusicnerd/StartWebcast-SyncPlayer-ForBrightsign` on `main`. Leave the token field blank for this public source. The updater looks for `updates/StartWebcast-SyncPlayer.swu` on the selected branch. Each player stores its own source settings. To use a different signing key, provision its public key on the card before installing packages signed with it.

## Build and Publish a Package

Generate the key pair once on a trusted workstation. Keep the private key outside the repository and off the players. Back it up securely. Use the same private key to sign subsequent updates for these cards.

```powershell
node tools/build_ota.js init C:/secure/ota-signing-key.pem C:/secure/update-trust.pem
python tools/stage_suite.py --provision --update-key C:/secure/update-trust.pem
```

Increase `VERSION` for each new release, run the project tests, then build and commit the signed package to the chosen GitHub branch.

```powershell
node tools/build_ota.js build C:/secure/ota-signing-key.pem updates/StartWebcast-SyncPlayer.swu
```

Each package contains the complete updateable app, with a 2 MiB transfer limit. SD bootloader changes require a card or Diagnostic Web Server update. The stable bootloader keeps a base runtime available for recovery. Staging verifies an Ed25519 signature and writes files to an inactive directory before selecting a version. The app confirms health when native playback starts and HTTPS listens. A missed health check causes one recovery restart.

## Operator API

The authenticated routes are `GET /api/v1/updates`, `PUT /api/v1/updates/github` with `repository` and `branch`, `PUT /api/v1/updates/package` with `application/octet-stream`, and `POST /api/v1/updates/download` with an optional `token`. Use `POST /api/v1/updates/activate` or `POST /api/v1/updates/rollback` to apply the selected operation and restart. Include `X-SyncPlayer-Request: control` on changes.
