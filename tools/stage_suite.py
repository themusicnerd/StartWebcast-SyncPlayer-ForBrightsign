"""Refresh the existing presentation cards and build a credential-free SD update."""

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil

from build_release import ROOT, sha256, write_zip
from prepare_sdcards import write_card_boot_files
from provision_clock_web import provision


def provision_peers(cards):
    paths = {player: card / "clock/peer-credentials.json" for player, card in cards.items()}
    if all(path.exists() for path in paths.values()):
        return
    if any(path.exists() for path in paths.values()):
        raise ValueError("Peer provisioning is incomplete. Restore the matching private files before continuing.")
    exchange = {player: {"clients": {}, "leaders": {}} for player in cards}
    for leader, card in cards.items():
        ca = (card / "clock/clock-cert.pem").read_text(encoding="ascii")
        for follower in cards:
            if leader == follower:
                continue
            token = secrets.token_hex(32)
            exchange[leader]["clients"][follower] = hashlib.sha256(token.encode("ascii")).hexdigest()
            exchange[follower]["leaders"][leader] = {"token": token, "ca": ca}
    for player, path in paths.items():
        path.write_text(json.dumps(exchange[player]), encoding="ascii")


def stage(root, output, openssl):
    players = sorted(path for path in root.iterdir() if path.is_dir() and (path / "syncplayer.json").is_file())
    if not players:
        raise ValueError("No prepared player directories were found")
    cards = {}
    package = {"CONTENT-CARDS.md": ROOT / "docs/CONTENT-CARDS.md"}
    if (ROOT / "docs/SUITE.md").is_file():
        package["SUITE.md"] = ROOT / "docs/SUITE.md"
        package["API_VERIFICATION.md"] = ROOT / "docs/API_VERIFICATION.md"
    for card in players:
        config_bytes = (card / "syncplayer.json").read_bytes()
        config = json.loads(config_bytes)
        player = config["card_player_id"]
        if player in cards or card.name != f"Player{player}":
            raise ValueError(f"Duplicate or incorrect card directory {card.name}")
        previous = (card / "SHA256SUMS").read_text(encoding="ascii").splitlines()
        media = {name: digest for digest, name in (line.split("  ", 1) for line in previous) if name.startswith("media/")}
        if set(media) != {"media/HOLDING.jpeg", f"media/Presentation_{player}.mp4"} or any(sha256(card / name) != digest for name, digest in media.items()):
            raise ValueError(f"Media verification failed for {card.name}")
        write_card_boot_files(card, config, player, media)
        if (card / "syncplayer.json").read_bytes() != config_bytes:
            raise ValueError(f"Check the regenerated configuration for {card.name}")
        if openssl and not (card / "clock/credentials.json").exists():
            password = (card / "dws-password.txt").read_text(encoding="ascii").rstrip("\r\n")
            provision(card, "SyncPlayer", password, openssl)
        cards[player] = card
        names = [line.split("  ", 1)[1] for line in (card / "SHA256SUMS").read_text(encoding="ascii").splitlines()]
        for name in ["SHA256SUMS", *names]:
            if not name.startswith("media/"):
                package[f"{card.name}/{name}"] = card / name
    if set(cards) != set(config["players"].values()):
        raise ValueError("Provide each player in the group")
    if openssl:
        provision_peers(cards)
    version = (ROOT / "VERSION").read_text(encoding="ascii").strip()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"Start-SyncPlayer-{version}-SD-Update.zip"
    write_zip(archive, package)
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=ROOT / "sdcard")
    parser.add_argument("--output", type=Path, default=ROOT / "releases")
    parser.add_argument("--provision", action="store_true", help="Provision private peer files and missing web logins")
    parser.add_argument("--openssl", default=shutil.which("openssl"))
    args = parser.parse_args()
    if args.provision and not args.openssl:
        parser.error("OpenSSL is required for private provisioning")
    try:
        print(stage(args.cards.resolve(), args.output.resolve(), args.openssl if args.provision else None))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"SD update failed. {error}\n")


if __name__ == "__main__":
    main()
