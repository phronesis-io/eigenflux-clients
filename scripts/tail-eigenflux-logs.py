#!/usr/bin/env python3
"""Tail OpenClaw daily log files and print EigenFlux log messages.

Watches /tmp/openclaw/openclaw-YYYY-MM-DD.log, automatically rotating to
the newest file when a new day's log appears. For each line, parses the
JSON envelope, filters entries whose "0" field mentions "eigenflux", and
prints the "1" field.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from typing import Optional, TextIO

DEFAULT_LOG_DIR = "/tmp/openclaw"
DEFAULT_PATTERN = "openclaw-*.log"
POLL_INTERVAL_SEC = 0.25


def find_latest_log(log_dir: str, pattern: str) -> Optional[str]:
    matches = glob.glob(os.path.join(log_dir, pattern))
    if not matches:
        return None
    return max(matches, key=os.path.getmtime)


def open_tail(path: str, from_start: bool) -> TextIO:
    fh = open(path, "r", encoding="utf-8", errors="replace")
    if not from_start:
        fh.seek(0, os.SEEK_END)
    return fh


def process_line(line: str) -> None:
    line = line.strip()
    if not line:
        return
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return

    tag = record.get("0")
    if not isinstance(tag, str) or "eigenflux" not in tag.lower():
        return

    message = record.get("1")
    if message is None:
        return

    if not isinstance(message, str):
        message = json.dumps(message, ensure_ascii=False)

    meta = record.get("_meta") or {}
    level = meta.get("logLevelName") or "INFO"
    timestamp = record.get("time") or meta.get("date") or ""

    print(f"[{timestamp}] [{level}] {message}", flush=True)


def current_inode(path: str) -> Optional[int]:
    try:
        return os.stat(path).st_ino
    except FileNotFoundError:
        return None


def tail_loop(log_dir: str, pattern: str, from_start: bool) -> None:
    current_path: Optional[str] = None
    current_ino: Optional[int] = None
    fh: Optional[TextIO] = None

    try:
        while True:
            latest = find_latest_log(log_dir, pattern)

            if latest is None:
                if fh is not None:
                    fh.close()
                    fh = None
                    current_path = None
                    current_ino = None
                time.sleep(POLL_INTERVAL_SEC)
                continue

            latest_ino = current_inode(latest)

            rotated = (
                fh is None
                or latest != current_path
                or (latest_ino is not None and latest_ino != current_ino)
            )

            if rotated:
                if fh is not None:
                    fh.close()
                print(f"--- tailing {latest} ---", file=sys.stderr, flush=True)
                fh = open_tail(latest, from_start=from_start if current_path is None else True)
                current_path = latest
                current_ino = latest_ino

            assert fh is not None
            line = fh.readline()
            if line:
                process_line(line)
                continue

            # No new data; small sleep, then re-check for rotation.
            time.sleep(POLL_INTERVAL_SEC)
    finally:
        if fh is not None:
            fh.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--log-dir",
        default=DEFAULT_LOG_DIR,
        help=f"Directory containing OpenClaw log files (default: {DEFAULT_LOG_DIR})",
    )
    parser.add_argument(
        "--pattern",
        default=DEFAULT_PATTERN,
        help=f"Glob pattern for log files (default: {DEFAULT_PATTERN})",
    )
    parser.add_argument(
        "--from-start",
        action="store_true",
        help="Read the current log file from the beginning (default: start at EOF like tail -f)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        tail_loop(args.log_dir, args.pattern, args.from_start)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
