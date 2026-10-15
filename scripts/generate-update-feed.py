#!/usr/bin/env python3
"""Publish bounded, public release metadata for clients without GitHub API quota."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess

REPOSITORY = "asoming/writer-desk"
RELEASE_ROOT = f"https://github.com/{REPOSITORY}/releases/download/"
MAX_ASSET = 512 * 1024 ** 2
MAX_FEED = 2 * 1024 ** 2
MAX_RELEASES = 30
SUFFIXES = ("linux-amd64.deb", "linux-x64.tar.gz", "windows-x64.exe",
            "mac-arm64.dmg", "mac-x64.dmg")


def checksum_name(name):
    return name[:-7] + ".sha256" if name.endswith(".tar.gz") else name + ".sha256"


def release_feed(releases):
    if not isinstance(releases, list) or len(releases) > 100:
        raise ValueError("Expected at most 100 GitHub releases")
    result, seen = [], set()
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") is not False:
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not re.fullmatch(r"v\d{1,6}\.\d{1,6}\.\d{1,6}", tag):
            continue
        if type(release.get("prerelease")) is not bool:
            continue
        published = release.get("published_at")
        try:
            stamp = datetime.fromisoformat(published.replace("Z", "+00:00"))
            if stamp.tzinfo is None or stamp.utcoffset() != timezone.utc.utcoffset(stamp):
                continue
        except (AttributeError, TypeError, ValueError):
            continue
        if tag in seen:
            raise ValueError("Duplicate public release tag")
        seen.add(tag)
        assets = release.get("assets")
        if not isinstance(assets, list) or len(assets) > 1000:
            continue
        counts = Counter(item.get("name") for item in assets
                         if isinstance(item, dict) and isinstance(item.get("name"), str))
        selected = []
        for suffix in SUFFIXES:
            filename = "WriterDesk-" + tag[1:] + "-" + suffix
            pair = []
            for name, limit in ((filename, MAX_ASSET), (checksum_name(filename), 1024)):
                if counts[name] != 1:
                    break
                item = next(item for item in assets if isinstance(item, dict) and item.get("name") == name)
                if (type(item.get("size")) is not int or not 0 < item["size"] <= limit
                        or item.get("state") != "uploaded"
                        or item.get("browser_download_url") != RELEASE_ROOT + tag + "/" + name):
                    break
                pair.append({key: item[key] for key in ("name", "size", "state", "browser_download_url")})
            if len(pair) == 2:
                selected.extend(pair)
        if not selected:
            continue
        body = release.get("body")
        result.append({"tag_name": tag, "draft": False, "prerelease": release["prerelease"],
                       "published_at": published, "body": body[:4000] if isinstance(body, str) else "",
                       "assets": selected})
    result.sort(key=lambda release: tuple(map(int, release["tag_name"][1:].split("."))), reverse=True)
    return result[:MAX_RELEASES]


def encoded_feed(releases):
    payload = (json.dumps(release_feed(releases), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(payload) > MAX_FEED:
        raise ValueError("Update feed exceeds the client metadata limit")
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--input", type=Path, help="Use a saved GitHub releases response")
    args = parser.parse_args()
    if args.input:
        raw = args.input.read_bytes()
    else:
        raw = subprocess.run(["gh", "api", f"repos/{REPOSITORY}/releases?per_page=100"],
                             check=True, capture_output=True, timeout=60).stdout
    if len(raw) > 16 * 1024 ** 2:
        raise ValueError("GitHub release response exceeds the input limit")
    payload = encoded_feed(json.loads(raw))
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_bytes(payload)
    print(json.dumps({"repository": REPOSITORY, "publicReleases": len(json.loads(payload)),
                      "bytes": len(payload)}))


if __name__ == "__main__":
    main()
