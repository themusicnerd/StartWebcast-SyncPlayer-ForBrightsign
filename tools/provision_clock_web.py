"""Create one player's private web credentials and HTTPS certificate."""

import argparse
import getpass
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile


def provision(card, username, password, openssl):
    config = json.loads((card / "syncplayer.json").read_text(encoding="utf-8"))
    address = ipaddress.IPv4Address(config["static_ipv4"]["address"])
    if config["players"].get(str(address)) != config["card_player_id"]:
        raise ValueError("Select a valid player card directory")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", username):
        raise ValueError("Use 1–40 letters, digits, dots, dashes or underscores for the username")
    if not re.fullmatch(r"[!-~]{8,128}", password):
        raise ValueError("Use 8–128 printable ASCII characters for the password")
    destination = card / "clock"
    if not (destination / "server.js").is_file():
        raise ValueError("Copy the management app to the card before provisioning it")
    if (destination / "credentials.json").exists():
        raise ValueError("This card already has clock credentials")

    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("ascii"), salt=salt, n=16384, r=8, p=1, dklen=32)
    with tempfile.TemporaryDirectory(prefix=".provision-", dir=destination) as staging:
        stage = Path(staging)
        subprocess.run([
            openssl, "req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-nodes", "-days", "825", "-subj", f"/CN={address}", "-addext", f"subjectAltName=IP:{address}",
            "-addext", "basicConstraints=critical,CA:FALSE",
            "-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=serverAuth",
            "-keyout", str(stage / "clock-key.pem"), "-out", str(stage / "clock-cert.pem"),
        ], check=True, capture_output=True)
        (stage / "credentials.json").write_text(json.dumps({
            "username": username, "salt": salt.hex(), "digest": digest.hex(),
        }), encoding="ascii")
        # Install the credential last so the app stays disabled during provisioning.
        for name in ("clock-key.pem", "clock-cert.pem", "credentials.json"):
            (stage / name).replace(destination / name)
    return f"https://{address}:8080/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card", type=Path)
    parser.add_argument("--username", default="SyncPlayer")
    parser.add_argument("--password-file", type=Path, help="Read an existing local provisioning password")
    parser.add_argument("--openssl", default=shutil.which("openssl"), help="Path to the OpenSSL executable")
    args = parser.parse_args()
    if not args.openssl:
        parser.error("OpenSSL is required on the workstation")
    try:
        if args.password_file:
            password = args.password_file.read_text(encoding="ascii").rstrip("\r\n")
        else:
            password = getpass.getpass("Clock web password: ")
            if password != getpass.getpass("Confirm password: "):
                raise ValueError("Passwords differ")
        url = provision(args.card.resolve(), args.username, password, args.openssl)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Clock provisioning failed. {error}\n")
    print(f"Clock web provisioned at {url}")


if __name__ == "__main__":
    main()
