"""Fork-only proof through the supported CLI, real inventory, and a 122-column PTY."""

import argparse
import ctypes
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
import sys
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


def enable_subreaper():
    # Detached CLI workers become our children when their launcher exits.
    # https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def process_info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return int(fields[1]), int(fields[19]), fields[0]
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned_descendants():
    processes = {
        int(path.name): info
        for path in Path("/proc").iterdir()
        if path.name.isdecimal() and (info := process_info(int(path.name))) is not None
    }
    owners = {os.getpid()}
    while True:
        children = {pid for pid, (parent, _, _) in processes.items() if parent in owners}
        if children <= owners:
            break
        owners.update(children)
    return {pid: processes[pid] for pid in owners if pid != os.getpid()}


def cleanup_owned(process, grace):
    signaled = []
    for kind, seconds in [(signal.SIGTERM, grace), (signal.SIGKILL, 2)]:
        deadline = time.monotonic() + seconds
        sent = set()
        while True:
            process.poll()  # Popen retains its own leader's actual exit status.
            descendants = owned_descendants()
            for pid, (parent, _, state) in descendants.items():
                if parent == os.getpid() and state == "Z" and pid != process.pid:
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            live = {pid: info for pid, info in descendants.items() if info[2] != "Z"}
            if not live:
                return {"signals": signaled, "remaining": []}
            for pid, info in live.items():
                identity = (pid, info[1])
                if identity in sent:
                    continue
                try:
                    descriptor = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    current = process_info(pid)
                    # Binding the signal to a pidfd also excludes PID reuse after this check.
                    if current is not None and current[1] == info[1]:
                        signal.pidfd_send_signal(descriptor, kind)
                        signaled.append({"pid": pid, "startTime": info[1], "signal": int(kind)})
                        sent.add(identity)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(descriptor)
            if time.monotonic() >= deadline:
                break
            select.select([], [], [], min(0.02, max(0, deadline - time.monotonic())))
    return {"signals": signaled, "remaining": [pid for pid, info in owned_descendants().items() if info[2] != "Z"]}


def drain_pty(master, stdout, deadline):
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], max(0, min(1, deadline - time.monotonic())))
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return True
                raise
            if not chunk:
                return True
            stdout.extend(chunk)
    return False


def capture_command(command, source, env, output, label, terminal=False, budget=1200, grace=10):
    started = time.monotonic()
    deadline = started + budget
    stdout = bytearray()
    stdout_path = output / (label + ".stdout.txt")
    stderr_path = output / (label + ".stderr.txt")
    stdout_file = None
    stderr_file = None
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
            if not drain_pty(master, stdout, deadline):
                raise TimeoutError("Actual CLI exceeded the proof execution budget")
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        else:
            # Regular artifacts retain partial diagnostics even if wait times out.
            stdout_file = stdout_path.open("wb")
            stderr_file = stderr_path.open("wb")
            process = subprocess.Popen(
                command, cwd=source, env=env, stdin=subprocess.DEVNULL,
                stdout=stdout_file, stderr=stderr_file, start_new_session=True,
            )
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        result["exitCode"] = process.returncode
    except BaseException as error:
        result["error"] = str(error)
        raise
    finally:
        try:
            if process is not None:
                result["cleanup"] = cleanup_owned(process, grace)
                if terminal and master is not None:
                    result["drainComplete"] = drain_pty(master, stdout, time.monotonic() + 2)
                result["exitCode"] = process.poll()
                if result["cleanup"]["remaining"] or result.get("drainComplete") is False:
                    result["cleanupError"] = "Owned command descendants or output did not finish within cleanup budget"
                    raise RuntimeError(result["cleanupError"])
        finally:
            if master is not None:
                os.close(master)
            if slave is not None:
                os.close(slave)
            for stream in [stdout_file, stderr_file]:
                if stream is not None:
                    stream.close()
            result["seconds"] = round(time.monotonic() - started, 3)
            if terminal:
                stdout_path.write_bytes(stdout)
                stderr_path.write_bytes(b"")
            write_json(output / (label + ".command.json"), result)
    return result, stdout_path.read_text(encoding="utf-8")


def cli(source, env, output, label, options, terminal=False):
    command = ["pnpm", "--silent", "openclaw", "plugins", "list", "--enabled", *options]
    result, transcript = capture_command(command, source, env, output, label, terminal=terminal)
    assert result["exitCode"] == 0, f"{label}: CLI failed; this is not an expected regression RED"
    return transcript


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


def self_check(output):
    # The pipe is a readiness barrier: the launcher cannot exit/block until its
    # detached worker has installed SIGTERM handling and emitted both streams.
    child = r"""
import os, signal, sys
read_fd, write_fd = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(read_fd)
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(sys.argv[1], 'w') as target:
        target.write(str(os.getpid()))
    os.write(1, b'SYNTHETIC_STDOUT_READY\n')
    os.write(2, b'SYNTHETIC_STDERR_READY\n')
    os.write(write_fd, b'1')
    os.close(write_fd)
    while True:
        signal.pause()
os.close(write_fd)
assert os.read(read_fd, 1) == b'1'
os.close(read_fd)
if sys.argv[2] == 'exit':
    os._exit(0)
while True:
    signal.pause()
"""
    for terminal, mode in [(True, "exit"), (False, "block")]:
        label = "leader-exited-pty" if terminal else "timeout-file-logs"
        pid_path = output / (label + ".pid.txt")
        try:
            capture_command(
                [sys.executable, "-c", child, str(pid_path), mode], output,
                {"PATH": os.environ["PATH"]}, output, label, terminal=terminal, budget=2, grace=0.1,
            )
        except (TimeoutError, subprocess.TimeoutExpired):
            pass
        else:
            raise AssertionError("Synthetic worker must hold the terminal or launcher until timeout")
        metadata = json.loads((output / (label + ".command.json")).read_text())
        assert metadata["error"] and metadata["cleanup"]["remaining"] == []
        assert any(item["signal"] == signal.SIGKILL for item in metadata["cleanup"]["signals"])
        pid = int(pid_path.read_text())
        assert process_info(pid) is None, "Detached synthetic worker must be killed and reaped"
        stdout = (output / (label + ".stdout.txt")).read_bytes()
        stderr = (output / (label + ".stderr.txt")).read_bytes()
        assert stdout.count(b"SYNTHETIC_STDOUT_READY") == 1
        if terminal:
            assert metadata["exitCode"] == 0, "This case must exercise cleanup after launcher exit"
            assert stdout.count(b"SYNTHETIC_STDERR_READY") == 1
        else:
            assert stderr == b"SYNTHETIC_STDERR_READY\n", "Timeout must retain complete prior stderr"
            assert stdout == b"SYNTHETIC_STDOUT_READY\n", "Timeout must retain complete prior stdout"
    assert owned_descendants() == {}, "Self-check must leave no owned process behind"
    write_json(output / "self-check.json", {"complete": True, "cases": 2})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--stage", choices=["base", "head"])
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    enable_subreaper()
    if args.self_check:
        self_check(output)
        return
    if args.source is None or args.stage is None:
        parser.error("Real CLI proof requires --source and --stage")
    source = args.source.resolve()
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
