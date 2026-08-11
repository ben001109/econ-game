#!/usr/bin/env python3
"""Simple supervisor to run the Python uv services together."""

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent

SERVICE_SPECS = {
    "api": {
        "project": "python/services/api",
        "scripts": {"dev": "api-dev", "prod": "api-prod"},
    },
    "worker": {
        "project": "python/services/worker",
        "scripts": {"dev": "worker-dev", "prod": "worker-prod"},
    },
    "frontend": {
        "project": "python/services/frontend",
        "scripts": {"dev": "frontend-dev", "prod": "frontend-prod"},
    },
    "bot": {
        "project": "python/services/bot",
        "scripts": {"dev": "bot-dev", "prod": "bot-prod"},
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one or more Econ Game Python services via uv."
    )
    available = ", ".join(sorted(SERVICE_SPECS.keys()))
    parser.add_argument(
        "services",
        nargs="*",
        metavar="SERVICE",
        help=f"Services to launch (default: all). Choices: {available}",
    )
    parser.add_argument(
        "--mode",
        choices=("dev", "prod"),
        default="dev",
        help="Which uv script group to run (default: dev).",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List service names and exit.",
    )
    args = parser.parse_args()

    valid = set(SERVICE_SPECS.keys())

    if args.list:
        print("Available services:", ", ".join(sorted(valid)))
        sys.exit(0)

    selected = args.services or list(valid)
    unknown = sorted(set(selected) - valid)
    if unknown:
        parser.error(f"unknown services: {', '.join(unknown)}")

    args.services = selected
    return args


async def launch_service(name: str, mode: str) -> asyncio.subprocess.Process:
    spec = SERVICE_SPECS[name]
    try:
        script = spec["scripts"][mode]
    except KeyError as exc:  # pragma: no cover - defensive guard
        raise RuntimeError(f"no script defined for {name} ({mode})") from exc

    cmd = [
        "uv",
        "run",
        "--project",
        spec["project"],
        script,
    ]
    print(f"[+] starting {name} ({mode}) -> {' '.join(cmd)}")
    return await asyncio.create_subprocess_exec(*cmd, cwd=str(REPO_ROOT))


async def watch_service(name: str, proc: asyncio.subprocess.Process) -> tuple[str, int]:
    code = await proc.wait()
    return name, code


def install_signal_handlers(stop_event: asyncio.Event) -> None:
    def _handler(signum, _frame) -> None:
        if not stop_event.is_set():
            print(f"\n[!] received signal {signum}; stopping services...")
            stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handler)
        except (ValueError, AttributeError):  # pragma: no cover - platform dependent
            pass


async def supervise(services: Iterable[str], mode: str) -> int:
    stop_event = asyncio.Event()
    install_signal_handlers(stop_event)

    processes: dict[str, asyncio.subprocess.Process] = {}
    watchers: list[asyncio.Task[tuple[str, int]]] = []

    try:
        for name in services:
            proc = await launch_service(name, mode)
            processes[name] = proc
            watchers.append(asyncio.create_task(watch_service(name, proc)))

        stop_task = asyncio.create_task(stop_event.wait())
        first_done, _pending = await asyncio.wait(
            [stop_task, *watchers], return_when=asyncio.FIRST_COMPLETED
        )

        # Determine why we left the wait loop.
        exit_code = 0
        if stop_task in first_done:
            print("[i] stop requested by user")
        else:
            finished_task = next(iter(first_done))
            service_name, code = finished_task.result()
            exit_code = code
            if code == 0:
                print(f"[i] {service_name} exited cleanly; shutting down the rest")
            else:
                print(f"[!] {service_name} crashed with code {code}; stopping others")
            stop_event.set()

        stop_task.cancel()

        # Terminate remaining services.
        for name, proc in processes.items():
            if proc.returncode is None:
                print(f"[-] stopping {name}")
                proc.terminate()

        await asyncio.gather(*watchers, return_exceptions=True)
        return exit_code
    finally:
        for task in watchers:
            task.cancel()


def main() -> None:
    args = parse_args()
    try:
        code = asyncio.run(supervise(args.services, args.mode))
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)


if __name__ == "__main__":
    main()
