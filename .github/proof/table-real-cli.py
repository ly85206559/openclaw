"""Fork-only proof through the supported CLI, real inventory, and a 122-column PTY."""

import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


BASE = "fa420c6eb2752a78430cef1f2e3bf15cc17d8e9e"
HEAD = "2a34ff24e0f315ce108823c4101a48dd4500e329"
NAME = "n" * 40
DESCRIPTION = "d" * 30
VERSION = "2026.9.8"
COLUMNS = 122
ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def plain(text):
    return ANSI.sub("", text).replace("\r\n", "\n")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def source_identity(source):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=source, text=True).strip()

    paths = ["packages/terminal-core/src/table.ts", "pnpm-lock.yaml", "package.json"]
    return {
        "sha": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "files": {
            path: {
                "blob": git("rev-parse", "HEAD:" + path),
                "sha256": hashlib.sha256((source / path).read_bytes()).hexdigest(),
            }
            for path in paths
        },
        "trackedDiff": git("diff", "--name-only", "HEAD"),
    }


def cli(source, env, output, label, options, terminal=False):
    command = ["pnpm", "--silent", "openclaw", "plugins", "list", "--enabled", *options]
    started = time.monotonic()
    deadline = started + 1200
    stdout = bytearray()
    stderr = b""
    process = None
    master = None
    slave = None
    result = {"command": command, "terminal": terminal, "columns": COLUMNS if terminal else None}
    try:
        if terminal:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, COLUMNS, 0, 0))
            assert os.get_terminal_size(slave).columns == COLUMNS
            process = subprocess.Popen(
                command, cwd=source, env=env, stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True,
            )
            os.close(slave)
            slave = None
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Actual CLI exceeded the proof execution budget")
                ready, _, _ = select.select([master], [], [], min(remaining, 1))
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not chunk:
                        break
                    stdout.extend(chunk)
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        else:
            process = subprocess.Popen(
                command, cwd=source, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            )
            captured, stderr = process.communicate(timeout=deadline - time.monotonic())
            stdout.extend(captured)
        result["exitCode"] = process.returncode
    except BaseException as error:
        result["error"] = str(error)
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        raise
    finally:
        if master is not None:
            os.close(master)
        if slave is not None:
            os.close(slave)
        result["seconds"] = round(time.monotonic() - started, 3)
        (output / (label + ".stdout.txt")).write_bytes(stdout)
        (output / (label + ".stderr.txt")).write_bytes(stderr)
        write_json(output / (label + ".command.json"), result)
    assert result["exitCode"] == 0, f"{label}: CLI failed; this is not an expected regression RED"
    return bytes(stdout).decode("utf-8", errors="strict")


def table_rows(transcript):
    lines = plain(transcript).splitlines()
    header = next(i for i, line in enumerate(lines) if line.startswith("│") and line.split("│")[1].strip() == "Name")
    rows = []
    for line in lines[header + 1:]:
        if line.startswith("└"):
            break
        if line.startswith("│"):
            assert len(line) == COLUMNS, f"Unexpected actual table width: {len(line)}"
            cells = [cell.strip() for cell in line.split("│")[1:-1]]
            assert len(cells) == 6, "Expected the actual plugins-list six-column table"
            rows.append(cells)
    assert rows, "Actual CLI did not print plugin data rows"
    return rows


def inventory(payload, entry, description):
    plugins = payload["plugins"]
    assert len(plugins) == 1, f"Expected one real enabled plugin, got {len(plugins)}"
    plugin = plugins[0]
    expected = {
        "id": NAME, "name": NAME, "version": VERSION, "source": str(entry),
        "rootDir": str(entry.parent), "origin": "config", "format": "openclaw", "enabled": True,
    }
    for key, value in expected.items():
        assert plugin[key] == value, f"Real inventory {key}: {plugin.get(key)!r} != {value!r}"
    assert plugin.get("description", "") == description
    for diagnostic in [*payload["diagnostics"], *payload["registry"]["diagnostics"]]:
        assert diagnostic["level"] != "error", diagnostic


def proof_case(source, output, plugin_root, description, stage):
    label = "multiline" if description else "empty-description-control"
    case_output = output / label
    case_output.mkdir()
    home = case_output / "home"
    home.mkdir()
    state = home / "state"
    state.mkdir()
    entry = plugin_root / "index.js"
    package = {"name": NAME, "version": VERSION, "type": "module", "openclaw": {"extensions": ["./index.js"]}}
    manifest = {
        "id": NAME, "name": NAME, "description": description,
        "configSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    }
    config = {"plugins": {
        "enabled": True, "allow": [NAME], "load": {"paths": [str(plugin_root)]},
        "entries": {NAME: {"enabled": True}}, "slots": {"memory": "none"},
    }}
    write_json(plugin_root / "package.json", package)
    write_json(plugin_root / "openclaw.plugin.json", manifest)
    entry.write_text('export default { id: ' + json.dumps(NAME) + ', register() {} };\n', encoding="utf-8")
    config_path = home / "openclaw.json"
    write_json(config_path, config)
    write_json(case_output / "fixture.json", {"package": package, "manifest": manifest, "config": config, "entry": entry.read_text()})
    assert len(str(entry)) == 26, "Fixture geometry requires a 26-character actual source path"
    env = {
        "PATH": os.environ["PATH"], "LANG": "C.UTF-8", "CI": "true", "TERM": "xterm-256color",
        "FORCE_COLOR": "1", "HOME": str(home), "OPENCLAW_HOME": str(home),
        "OPENCLAW_STATE_DIR": str(state), "OPENCLAW_CONFIG_PATH": str(config_path),
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS": "1",
    }
    write_json(case_output / "environment.json", env)
    json_text = cli(source, env, case_output, "json", ["--json"])
    payload = json.loads(plain(json_text))
    inventory(payload, entry, description)
    transcript = cli(source, env, case_output, "table", [], terminal=True)
    rows = table_rows(transcript)
    name_parts = [row[0] for row in rows if row[0]]
    assert "".join(name_parts) == NAME, "Name bytes must remain complete, even on baseline"
    assert rows[0][1] == "" and rows[0][2] == "openclaw" and rows[0][3] == "enabled"
    assert rows[0][4] == str(entry) and rows[0][5] == VERSION
    if description:
        assert len(rows) == 2 and rows[1][4] == description
        if stage == "base":
            assert rows[0][0] != NAME and len(name_parts) == 2, "Baseline must expose unnecessary Name wrapping"
        else:
            assert rows[0][0] == NAME and rows[1][0] == "", "Fixed actual CLI must keep Name intact on the first line"
    else:
        assert len(rows) == 1 and rows[0][0] == NAME, "Single-line negative control must pass on both exact sources"
    verbose = plain(cli(source, env, case_output, "verbose", ["--verbose"]))
    assert NAME + " enabled" in verbose.splitlines()
    for line in ["  format: openclaw", "  source: " + str(entry), "  origin: config", "  version: " + VERSION]:
        assert line in verbose.splitlines(), f"Verbose metadata missing: {line}"
    write_json(case_output / "assertions.json", {
        "stage": stage, "actualInventory": "verified", "rows": rows,
        "nameIntactOnFirstLine": rows[0][0] == NAME,
        "expectedRegressionObserved": bool(description and stage == "base"),
        "jsonAndVerboseMetadata": "verified", "exitCodes": [0, 0, 0],
    })
    print(json.dumps({"stage": stage, "case": label, "rows": rows, "result": "expected behavior verified"}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--stage", required=True, choices=["base", "head"])
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    before = source_identity(source)
    write_json(output / "source-before.json", before)
    assert before["sha"] == (BASE if args.stage == "base" else HEAD)
    assert not before["trackedDiff"], "Proof must begin with exact unmodified source"
    plugin_root = Path(tempfile.mkdtemp(prefix="tbl-", dir="/tmp"))
    outcome = {"stage": args.stage, "sha": before["sha"], "complete": False}
    started = time.monotonic()
    try:
        proof_case(source, output, plugin_root, DESCRIPTION, args.stage)
        proof_case(source, output, plugin_root, "", args.stage)
        after = source_identity(source)
        write_json(output / "source-after.json", after)
        assert after == before, "Actual CLI proof must not drift the reviewed source"
        outcome["complete"] = True
        outcome["actualCliCommandsCompleted"] = 6
    except BaseException as error:
        outcome["error"] = str(error)
        raise
    finally:
        outcome["seconds"] = round(time.monotonic() - started, 3)
        write_json(output / "outcome.json", outcome)


if __name__ == "__main__":
    main()
