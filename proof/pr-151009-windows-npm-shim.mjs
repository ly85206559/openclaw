import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sourceRoot, phase] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.match(path.win32.basename(process.execPath), /^node24\.exe$/i);
assert.ok(path.isAbsolute(sourceRoot));
assert.ok(phase === "baseline" || phase === "candidate");
const { spawnTerminalPty } = await import(
  pathToFileURL(path.join(sourceRoot, "src/process/terminal-pty.ts")).href
);
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-pr151009-"));
const binDir = path.join(root, "bin");
const entrypoint = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
const shimPath = path.join(binDir, "codex.cmd");
const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
assert.ok(descriptor?.configurable, "execPath must be restorable for the negative control");
const inheritedWindowsEnv = Object.fromEntries(
  ["SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
const env = { ...inheritedWindowsEnv, PATH: binDir, PATHEXT: ".EXE;.CMD" };
const params = { file: shimPath, args: ["--", "literal"], env, cols: 80, rows: 24 };
const expectedError = /A Node executable is required to launch this Windows npm wrapper/;

async function receipt(handle) {
  let output = "";
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("PTY output timed out")), 30_000);
      handle.onData((chunk) => {
        output += chunk;
      });
      handle.onExit(({ exitCode: code }) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, `PTY exit ${exitCode}: ${output}`);
    const match = output.match(/OPENCLAW_PROOF (\{[^\r\n]+\})/);
    assert.ok(match, `Missing child receipt: ${output}`);
    return JSON.parse(match[1]);
  } finally {
    try {
      handle.kill();
    } catch {
      /* already exited */
    }
  }
}

try {
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(
    entrypoint,
    'console.log("OPENCLAW_PROOF " + JSON.stringify({execBase:require("node:path").basename(process.execPath),argv:process.argv.slice(2)}));\n',
  );
  // Same npm-generated wrapper structure exercised by the existing fixture.
  const relative = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
  const wrapper = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relative}" %*\r\n`;
  await writeFile(shimPath, wrapper);

  if (phase === "baseline") {
    await assert.rejects(() => spawnTerminalPty(params), expectedError);
    console.log("REAL_PTY_BASELINE=EXPECTED_NODE_ERROR");
  } else {
    const result = await receipt(await spawnTerminalPty(params));
    assert.equal(result.execBase.toLowerCase(), "node24.exe");
    assert.deepEqual(result.argv, ["--", "literal"]);
    console.log("REAL_PTY_CANDIDATE=" + JSON.stringify(result));
  }

  Object.defineProperty(process, "execPath", {
    ...descriptor,
    value: "C:\\OpenClaw\\openclaw.exe",
  });
  try {
    await assert.rejects(() => spawnTerminalPty(params), expectedError);
    console.log("NON_NODE_WITHOUT_PATH_NODE=REJECTED");
    await copyFile(descriptor.value, path.join(binDir, "node.exe"));
    const fallback = await receipt(await spawnTerminalPty(params));
    assert.equal(fallback.execBase.toLowerCase(), "node.exe");
    assert.deepEqual(fallback.argv, ["--", "literal"]);
    console.log("PATH_NODE_CONTROL=" + JSON.stringify(fallback));
  } finally {
    Object.defineProperty(process, "execPath", descriptor);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
