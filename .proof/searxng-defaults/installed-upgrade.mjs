import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "linux");
const sourceSha = "e9d96ad33a6531c9ded348234e3202163f3b6519";
assert.equal(process.env.SOURCE_SHA, sourceSha);
const scenario = process.env.PROOF_SCENARIO ?? "published-core-upgrade";
assert.ok(["published-core-upgrade", "latest-plugin-install"].includes(scenario));
const coreUpgrade = scenario === "published-core-upgrade";
const stableVersion = coreUpgrade ? "2026.10.3" : "2026.10.4";
const output = process.env.PROOF_OUTPUT_DIR;
const coreTarball = process.env.CANDIDATE_CORE_TARBALL;
const pluginTarball = process.env.CANDIDATE_PLUGIN_TARBALL;
for (const value of [output, pluginTarball]) assert.ok(value && path.isAbsolute(value));
if (coreUpgrade) assert.ok(coreTarball && path.isAbsolute(coreTarball));
else assert.equal(coreTarball, undefined, "latest-plugin-install must not install or inspect a candidate core archive");
await fs.mkdir(output, { recursive: true });
// This standalone installed-package proof cannot import the checkout's Vitest lifecycle helpers.
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-installed-upgrade-"));
const prefix = path.join(fixture, "prefix");
const state = path.join(fixture, "state");
const configPath = path.join(fixture, "openclaw.json");
const cliBin = path.join(prefix, "bin", "openclaw");
const coreRoot = path.join(prefix, "lib", "node_modules", "openclaw");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receipt = {
  sourceSha, scenario, stableVersion, hostVersion: stableVersion,
  pluginArtifactVersion: "2026.10.3", coreUpdaterInvoked: false,
  calls: [], requests: [], snapshots: [],
  packages: {}, errors: [], behaviorFailures: [],
};
const stablePackages = coreUpgrade ? {
  core: {
    name: "openclaw", version: "2026.10.3",
    metadata: "https://registry.npmjs.org/openclaw/2026.10.3",
    tarball: "https://registry.npmjs.org/openclaw/-/openclaw-2026.10.3.tgz",
    integrity: "sha512-ncl6LntMlf76K39LFhVrDXQTbaGNAG5j52f7PL5P8vIn0knWmCrvfAe9DHMslFq+47HeOWBH2CBYQH8zEb+UAA==",
  },
  plugin: {
    name: "@openclaw/searxng-plugin", version: "2026.10.3",
    metadata: "https://registry.npmjs.org/@openclaw%2Fsearxng-plugin/2026.10.3",
    tarball: "https://registry.npmjs.org/@openclaw/searxng-plugin/-/searxng-plugin-2026.10.3.tgz",
    integrity: "sha512-f0bJICQPC76obBHbUF/78F4f8pkspQLlmIDjL7xuvreYdHTc+wnowldOuMAVOQrBb1ijVyntp8lzXLccRua2BA==",
  },
} : {
  core: {
    name: "openclaw", version: "2026.10.4",
    metadata: "https://registry.npmjs.org/openclaw/2026.10.4",
    tarball: "https://registry.npmjs.org/openclaw/-/openclaw-2026.10.4.tgz",
    integrity: "sha512-+FH0StZF1tlTazM7JJGY6JePeJmhFNSRByi2Q3jXPRiLO7o4dJh2xa9Vy4Dk8Cd2ic8B7Zkf5NfEaCCWUkgqnQ==",
  },
  plugin: {
    name: "@openclaw/searxng-plugin", version: "2026.10.4",
    metadata: "https://registry.npmjs.org/@openclaw%2Fsearxng-plugin/2026.10.4",
    tarball: "https://registry.npmjs.org/@openclaw/searxng-plugin/-/searxng-plugin-2026.10.4.tgz",
    integrity: "sha512-brQtRmi091fqUH5TRgilST1//Zhyfve4Ri44KW3P6+T/ryBXlw1uvNr3cvfezZUfCIZV33xFovc1e+TtmWK1Lw==",
  },
};
const env = {
  PATH: `${path.join(prefix, "bin")}:${process.env.PATH}`,
  HOME: fixture, OPENCLAW_HOME: fixture, OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_CACHE: path.join(fixture, "npm-cache"),
  NPM_CONFIG_USERCONFIG: path.join(fixture, "empty.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(fixture, "empty-global.npmrc"),
  CI: "true", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb",
  OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_DISABLE_BACKGROUND_TASKS: "1",
};
const activeChildren = new Map();
const responseTimers = new Set();
const cases = [
  { name: "stable-configured-count", expectedCount: 4 },
  { name: "stable-explicit-count", limit: 3, expectedCount: 3 },
  { name: "stable-configured-timeout", responseDelayMs: 2_000, expectedCount: 4 },
  { name: "candidate-configured-count", expectedCount: 1 },
  { name: "candidate-explicit-count", limit: 3, expectedCount: 3 },
  { name: "candidate-configured-timeout", responseDelayMs: 2_000, expectTimeout: true },
];
const casesByQuery = new Map(cases.map((testCase) => [`installed-upgrade-${testCase.name}`, testCase]));
const groupExists = (pid) => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function joinGroup(pid, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  while (groupExists(pid) && Date.now() < deadline) await delay(50);
  assert.equal(groupExists(pid), false, "installed command process group must terminate naturally");
}
async function stopChild(child, call) {
  if (!child.pid || !groupExists(child.pid)) return;
  process.kill(-child.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (groupExists(child.pid) && Date.now() < deadline) await delay(50);
  call.failureCleanup = { forcedKill: groupExists(child.pid), processGroupGone: false };
  if (call.failureCleanup.forcedKill) process.kill(-child.pid, "SIGKILL");
  await joinGroup(child.pid, 5_000);
  call.failureCleanup.processGroupGone = true;
}
async function run(name, command, args, budgetMs = 90_000) {
  const call = {
    name, command, args, cwd: fixture, processGroupGone: false,
    watchdogFired: false, forcedKill: false,
  };
  receipt.calls.push(call);
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: fixture, detached: true, stdio: ["ignore", "pipe", "pipe"], env,
  });
  activeChildren.set(child, call);
  let stdout = "", stderr = "", overflow = false;
  const stop = () => {
    if (child.pid && groupExists(child.pid)) process.kill(-child.pid, "SIGTERM");
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 8_000_000) { overflow = true; stop(); }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8_000_000) { overflow = true; stop(); }
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let killTimer, finalTimer, rejectDeadline;
  const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    call.watchdogFired = true;
    stop();
    killTimer = setTimeout(() => {
      if (child.pid && groupExists(child.pid)) {
        call.forcedKill = true;
        process.kill(-child.pid, "SIGKILL");
      }
      finalTimer = setTimeout(() => rejectDeadline(new Error("command pipes did not close after watchdog cleanup")), 5_000);
    }, 5_000);
  }, budgetMs);
  try {
    call.exit = await Promise.race([closed, deadline]);
    assert.ok(child.pid);
    await joinGroup(child.pid);
    call.processGroupGone = true;
    activeChildren.delete(child);
    assert.equal(call.watchdogFired, false, "command watchdog is a proof failure");
    assert.equal(call.forcedKill, false, "command must not require forced termination");
    assert.equal(overflow, false, "command capture overflow is a proof failure");
    assert.equal(call.exit.signal, null);
    call.stdout = stdout;
    call.stderr = stderr;
    return call;
  } catch (error) {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(finalTimer);
    await stopChild(child, call);
    if (!child.pid || !groupExists(child.pid)) activeChildren.delete(child);
    if (call.watchdogFired) { child.stdout.destroy(); child.stderr.destroy(); }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(finalTimer);
    call.wallMs = Date.now() - started;
    await fs.writeFile(path.join(output, `${name}.stdout.log`), stdout);
    await fs.writeFile(path.join(output, `${name}.stderr.log`), stderr);
    await fs.writeFile(path.join(output, `${name}.exit.json`), JSON.stringify(call, null, 2));
  }
}
function successful(call) {
  assert.deepEqual(call.exit, { code: 0, signal: null }, `${call.name} must succeed`);
  return call;
}
async function json(call) {
  call.envelope = JSON.parse(call.stdout);
  await fs.writeFile(path.join(output, `${call.name}.envelope.json`), JSON.stringify(call.envelope, null, 2));
  return call.envelope;
}
async function stableArchive(kind) {
  const expected = stablePackages[kind];
  const response = await fetch(expected.metadata, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.name, expected.name);
  assert.equal(metadata.version, expected.version);
  assert.equal(metadata.dist.tarball, expected.tarball);
  assert.equal(metadata.dist.integrity, expected.integrity);
  await fs.writeFile(path.join(output, `stable-${kind}.registry.json`), JSON.stringify(metadata, null, 2));
  const download = await fetch(expected.tarball, { signal: AbortSignal.timeout(120_000) });
  assert.equal(download.status, 200);
  assert.equal(download.url, expected.tarball);
  const bytes = Buffer.from(await download.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, expected.integrity, "published archive must match the independently pinned SRI");
  const archive = path.join(fixture, `stable-${kind}.tgz`);
  await fs.writeFile(archive, bytes);
  receipt.packages[`stable-${kind}`] = { ...expected, archive, bytes: bytes.length, sha256: sha256(bytes), integrity };
  return archive;
}
async function checkLatestTags() {
  receipt.latestPreflight = [];
  for (const [kind, expected] of Object.entries(stablePackages)) {
    const url = `${expected.metadata.slice(0, expected.metadata.lastIndexOf("/") + 1)}latest`;
    const startedAt = new Date().toISOString();
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200);
    const metadata = await response.json();
    const observed = {
      kind, url, startedAt, checkedAt: new Date().toISOString(), responseDate: response.headers.get("date"),
      name: metadata.name, version: metadata.version,
      tarball: metadata.dist?.tarball, integrity: metadata.dist?.integrity,
    };
    receipt.latestPreflight.push(observed);
    await fs.writeFile(path.join(output, `latest-${kind}.registry.json`), JSON.stringify(metadata, null, 2));
    assert.equal(metadata.name, expected.name);
    assert.equal(metadata.version, expected.version, "npm latest changed; requalify rather than claiming a stale latest-version proof");
    assert.equal(metadata.dist.tarball, expected.tarball);
    assert.equal(metadata.dist.integrity, expected.integrity);
  }
}
async function unpack(name, archive) {
  assert.equal((await fs.lstat(archive)).isFile(), true, "package input must be a regular archive");
  const bytes = await fs.readFile(archive);
  const listing = successful(await run(`${name}-tar-list`, "tar", ["-tzf", archive]));
  const entries = listing.stdout.trim().split("\n");
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(entry === "package" || entry.startsWith("package/"), "npm archive must have only the package root");
    assert.ok(!entry.includes("\\") && !entry.split("/").includes(".."), "archive entries must remain under the owned extraction root");
  }
  const destination = path.join(fixture, name);
  await fs.mkdir(destination);
  successful(await run(`${name}-tar-extract`, "tar", ["-xzf", archive, "-C", destination, "--no-same-owner", "--no-same-permissions"]));
  const root = path.join(destination, "package");
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "package inventory must not resolve through symlinks");
      if (entry.isDirectory()) await visit(absolute);
      else {
        assert.equal(entry.isFile(), true);
        files.push({ path: path.relative(root, absolute), sha256: sha256(await fs.readFile(absolute)) });
      }
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const inventory = {
    archive, archiveSha256: sha256(bytes),
    archiveIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    fileCount: files.length, manifest, files,
  };
  receipt.packages[name] = inventory;
  await fs.writeFile(path.join(output, `${name}.inventory.json`), JSON.stringify(inventory, null, 2));
  return { root, inventory };
}
async function compareInstalled(name, expected, installedRoot) {
  const root = await fs.realpath(installedRoot);
  assert.ok(root.startsWith(`${fixture}${path.sep}`), "runtime must be owned by the isolated installation, not the checkout");
  const lifecycleMarkers = [];
  let comparedFiles = 0;
  for (const file of expected.inventory.files) {
    const installed = path.join(root, file.path);
    if (expected.inventory.manifest.name === "openclaw" && file.path === ".openclaw-lifecycle-pending") {
      // scripts/postinstall-bundled-plugins.mjs consumes this shipped completion marker.
      // Require completed lifecycle state rather than retaining the archive's pending state.
      await assert.rejects(fs.lstat(installed), { code: "ENOENT" });
      lifecycleMarkers.push({ ...file, installedState: "consumed-by-package-lifecycle" });
      continue;
    }
    const resolved = await fs.realpath(installed);
    assert.ok(resolved.startsWith(`${root}${path.sep}`), "installed package files cannot escape their owner");
    assert.equal((await fs.lstat(installed)).isFile(), true);
    assert.equal(sha256(await fs.readFile(installed)), file.sha256, `installed ${file.path} must equal the packed artifact`);
    comparedFiles += 1;
  }
  assert.equal(lifecycleMarkers.length, expected.inventory.manifest.name === "openclaw" ? 1 : 0);
  const verification = {
    root, archiveSha256: expected.inventory.archiveSha256,
    comparedFiles, lifecycleMarkers,
  };
  await fs.writeFile(path.join(output, `${name}.identity.json`), JSON.stringify(verification, null, 2));
  return verification;
}
let preserved;
function selectedConfig(config) {
  return {
    search: config.tools?.web?.search,
    searxng: config.plugins?.entries?.searxng,
    enabled: config.plugins?.enabled,
    allow: config.plugins?.allow,
    deny: config.plugins?.deny,
    memory: config.plugins?.slots?.memory,
    ownership: config.agents?.ownership,
    defaultAgent: config.agents?.defaults?.systemAgent,
    agent: config.agents?.entries?.main,
  };
}
async function snapshot(name, verify = true) {
  const bytes = await fs.readFile(configPath);
  const config = JSON.parse(bytes.toString("utf8"));
  const selected = selectedConfig(config);
  await fs.writeFile(path.join(output, `${name}.config.json`), bytes);
  receipt.snapshots.push({ name, sha256: sha256(bytes), selected });
  if (verify) assert.deepEqual(selected, preserved, "the pre-upgrade authored selection and defaults must survive without rewriting config");
  return selected;
}
async function inspectPlugin(name, expected) {
  const call = successful(await run(name, cliBin, ["plugins", "inspect", "searxng", "--runtime", "--json"]));
  const report = await json(call);
  assert.equal(report.plugin.id, "searxng");
  assert.equal(report.plugin.status, "loaded");
  assert.equal(report.plugin.error, undefined);
  assert.ok(report.install?.installPath, "canonical registry must identify the managed plugin payload");
  const identity = await compareInstalled(`${name}-runtime`, expected, report.install.installPath);
  const entry = await fs.realpath(report.plugin.source);
  assert.ok(entry.startsWith(`${identity.root}${path.sep}`), "registered provider must resolve to the verified installed package");
  assert.ok(expected.inventory.files.some((file) => path.join(identity.root, file.path) === entry), "registered entry must belong to the packed inventory");
  const expectedVersion = expected.inventory.manifest.version;
  assert.equal(report.install.version, expectedVersion);
  assert.equal(report.install.source, "npm");
  assert.equal(report.install.resolvedName, "@openclaw/searxng-plugin");
  assert.equal(report.install.resolvedVersion, expectedVersion);
  assert.equal(report.install.resolvedSpec, `@openclaw/searxng-plugin@${expectedVersion}`);
  assert.equal(report.install.integrity, expected.inventory.archiveIntegrity);
  if (name === "candidate-plugin-inspect") {
    assert.equal(report.install.npmIntegrity, expected.inventory.archiveIntegrity);
    assert.equal(report.install.artifactKind, "npm-pack");
    assert.equal(await fs.realpath(report.install.sourcePath), await fs.realpath(pluginTarball));
  } else if (name === "stable-plugin-inspect") {
    assert.equal(report.install.spec, `@openclaw/searxng-plugin@${expectedVersion}`);
  } else {
    assert.equal(name, "post-core-stable-plugin-inspect");
    // Official cohort convergence restores the catalog selector, not new package bytes.
    assert.equal(report.install.spec, "@openclaw/searxng-plugin");
  }
  return { ...identity, source: entry, install: report.install };
}
function inspectSearch(call, testCase) {
  const requests = receipt.requests.filter((item) => item.name === testCase.name);
  assert.equal(requests.length, 1, "each installed CLI must issue exactly one real provider request");
  const request = requests[0];
  assert.ok(request.closedAt);
  if (testCase.expectTimeout) {
    assert.deepEqual(call.exit, { code: 1, signal: null });
    assert.equal(call.envelope.ok, false);
    assert.equal(call.envelope.error.type, "cli_error");
    assert.equal(call.envelope.error.message, "request timed out");
    assert.equal(request.closedBeforeResponse, true);
    assert.equal(request.responseSentAt, undefined);
    assert.ok(request.closedAfterMs >= 500 && request.closedAfterMs < 2_000, "timeout is measured after real HTTP receipt, not CLI startup");
    call.outcome = "configured-timeout-closed-request";
    return;
  }
  successful(call);
  assert.equal(call.stderr, "", "successful searches must not conceal stderr diagnostics");
  const envelope = call.envelope;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.capability, "web.search");
  assert.equal(envelope.transport, "local");
  assert.equal(envelope.provider, "searxng");
  assert.deepEqual(envelope.attempts, []);
  assert.equal(envelope.outputs.length, 1);
  assert.equal(envelope.error, undefined);
  const result = envelope.outputs[0].result;
  assert.equal(result.provider, "searxng");
  assert.equal(result.query, `installed-upgrade-${testCase.name}`);
  assert.equal(result.cached, undefined);
  assert.equal(result.count, testCase.expectedCount);
  assert.equal(result.results.length, testCase.expectedCount);
  for (const [index, row] of result.results.entries()) {
    assert.equal(row.url, `https://example.com/searxng/${testCase.name}/${index + 1}`);
    assert.ok(row.title.includes(`Fixture result ${index + 1}`));
    assert.ok(row.snippet.includes(`Synthetic snippet ${index + 1}`));
    assert.equal(row.siteName, "example.com");
  }
  assert.equal(request.closedBeforeResponse, false);
  assert.ok(request.responseSentAt);
  if (testCase.responseDelayMs) assert.ok(request.responseSentAt - request.receivedAt >= 1_950);
  call.outcome = `success-${result.count}-results`;
}
async function searches(stage) {
  for (const testCase of cases.filter((item) => item.name.startsWith(`${stage}-`))) {
    try {
      const args = ["infer", "web", "search", "--provider", "searxng", "--query", `installed-upgrade-${testCase.name}`];
      if (testCase.limit !== undefined) args.push("--limit", String(testCase.limit));
      args.push("--json");
      const call = await run(testCase.name, cliBin, args);
      await json(call);
    } catch (error) { receipt.errors.push({ name: error.name, message: error.message, case: testCase.name }); }
  }
  // Preserve every stage's physical outcome before its behavioral verdict.
  for (const testCase of cases.filter((item) => item.name.startsWith(`${stage}-`))) {
    try {
      const call = receipt.calls.find((item) => item.name === testCase.name);
      assert.ok(call);
      inspectSearch(call, testCase);
    } catch (error) { receipt.behaviorFailures.push({ case: testCase.name, name: error.name, message: error.message }); }
  }
}
const server = http.createServer((request, response) => {
  const receivedAt = Date.now();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const query = url.searchParams.get("q");
  const testCase = casesByQuery.get(query);
  const observed = {
    name: testCase?.name ?? "unknown", query, method: request.method, path: url.pathname,
    format: url.searchParams.get("format"), categories: url.searchParams.get("categories"),
    language: url.searchParams.get("language"), accept: request.headers.accept, receivedAt,
    responseDelayMs: testCase?.responseDelayMs ?? 0,
  };
  receipt.requests.push(observed);
  if (!testCase || request.method !== "GET" || url.pathname !== "/search" ||
      observed.format !== "json" || observed.categories !== "general" ||
      observed.language !== "en" || observed.accept !== "application/json") {
    receipt.errors.push({ name: "FixtureRequestError", message: "unexpected provider request", observed });
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected fixture request" }));
    return;
  }
  let responseTimer;
  response.on("finish", () => { observed.finishedAt = Date.now(); });
  response.on("close", () => {
    observed.closedAt = Date.now();
    observed.closedAfterMs = observed.closedAt - receivedAt;
    observed.closedBeforeResponse = !response.writableFinished;
    if (responseTimer) { clearTimeout(responseTimer); responseTimers.delete(responseTimer); }
  });
  response.on("error", (error) => receipt.errors.push({ name: "FixtureResponseError", message: error.message, case: testCase.name }));
  const answer = () => {
    if (responseTimer) responseTimers.delete(responseTimer);
    if (response.destroyed) return;
    observed.responseSentAt = Date.now();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results: Array.from({ length: 4 }, (_, index) => ({
      title: `Fixture result ${index + 1}`, url: `https://example.com/searxng/${testCase.name}/${index + 1}`,
      content: `Synthetic snippet ${index + 1}`,
    })) }));
  };
  if (testCase.responseDelayMs) {
    responseTimer = setTimeout(answer, testCase.responseDelayMs);
    responseTimers.add(responseTimer);
  } else answer();
});

try {
  await fs.mkdir(state);
  await fs.writeFile(env.NPM_CONFIG_USERCONFIG, "");
  await fs.writeFile(env.NPM_CONFIG_GLOBALCONFIG, "");
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  receipt.fixturePort = address.port;
  if (!coreUpgrade) await checkLatestTags();
  const stableCoreArchive = await stableArchive("core");
  const stablePluginArchive = await stableArchive("plugin");
  const stableCore = await unpack("stable-core-package", stableCoreArchive);
  const stablePlugin = await unpack("stable-plugin-package", stablePluginArchive);
  const candidateCore = coreUpgrade ? await unpack("candidate-core-package", coreTarball) : undefined;
  const candidatePlugin = await unpack("candidate-plugin-package", pluginTarball);
  assert.equal(candidatePlugin.inventory.manifest.name, "@openclaw/searxng-plugin");
  assert.equal(candidatePlugin.inventory.manifest.version, receipt.pluginArtifactVersion);
  if (coreUpgrade) {
    assert.equal(candidateCore.inventory.manifest.name, "openclaw");
    assert.equal(candidateCore.inventory.manifest.version, "2026.10.3");
    const buildInfo = JSON.parse(await fs.readFile(path.join(candidateCore.root, "dist", "build-info.json"), "utf8"));
    assert.equal(buildInfo.commit, sourceSha, "canonical candidate core package must identify the exact reviewed source");
    receipt.candidateBuildInfo = buildInfo;
    assert.notEqual(candidateCore.inventory.archiveSha256, stableCore.inventory.archiveSha256);
  } else {
    assert.equal(candidatePlugin.inventory.manifest.peerDependencies.openclaw, ">=2026.10.3");
    assert.equal(candidatePlugin.inventory.manifest.openclaw.compat.pluginApi, ">=2026.10.3");
  }
  assert.notEqual(candidatePlugin.inventory.archiveSha256, stablePlugin.inventory.archiveSha256);
  const oldManifest = JSON.parse(await fs.readFile(path.join(stablePlugin.root, "openclaw.plugin.json"), "utf8"));
  const newManifest = JSON.parse(await fs.readFile(path.join(candidatePlugin.root, "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(newManifest, oldManifest, "candidate must not introduce a new capability/config contract during this proof");

  successful(await run("install-stable-core", "npm", ["install", "--global", "--prefix", prefix, stableCoreArchive, "--omit=dev", "--no-audit", "--no-fund"], 600_000));
  receipt.stableCoreIdentity = await compareInstalled("stable-core-installed", stableCore, coreRoot);
  const stableBin = await fs.realpath(cliBin);
  assert.equal(stableBin, path.join(await fs.realpath(coreRoot), stableCore.inventory.manifest.bin.openclaw));
  // Bootstrap has no SearXNG settings; the released CLI owns the authored seed write below.
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: "local" },
    plugins: { enabled: true, allow: ["searxng"], slots: { memory: "none" } },
    agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: {
      main: { workspace: path.join(fixture, "workspace"), agentDir: path.join(fixture, "agent") },
    } },
  }));
  successful(await run("install-stable-plugin", cliBin, ["plugins", "install", `npm:@openclaw/searxng-plugin@${stableVersion}`, "--pin", "--no-enable"], 600_000));
  const seed = {
    tools: { web: { search: { provider: "searxng", cacheTtlMinutes: 0, maxResults: 1, timeoutSeconds: 1 } } },
    plugins: { entries: { searxng: { enabled: true, config: { webSearch: {
      baseUrl: `http://127.0.0.1:${address.port}`, categories: "general", language: "en",
    } } } } },
  };
  const seedPath = path.join(fixture, "existing-config-seed.json");
  await fs.writeFile(seedPath, JSON.stringify(seed));
  successful(await run("stable-author-config", cliBin, ["config", "patch", "--file", seedPath]));
  const validation = await json(successful(await run("stable-config-validate", cliBin, ["config", "validate", "--json"])));
  assert.equal(validation.valid, true);
  preserved = await snapshot("before-upgrade", false);
  assert.deepEqual(preserved.search, seed.tools.web.search);
  assert.deepEqual(preserved.searxng, seed.plugins.entries.searxng);
  receipt.stablePluginIdentity = await inspectPlugin("stable-plugin-inspect", stablePlugin);
  await searches("stable");
  await snapshot("after-stable-searches");
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.behaviorFailures, [], "published stable baseline must actually exhibit the expected default failures and explicit control");
  receipt.stableBaselineObserved = true;

  if (coreUpgrade) {
    receipt.coreUpdaterInvoked = true;
    const update = successful(await run("stable-installed-updater", cliBin, ["update", "--tag", coreTarball, "--no-restart", "--yes", "--json"], 600_000));
    const updateResult = await json(update);
    assert.equal(updateResult.status, "ok");
    assert.equal(updateResult.mode, "npm");
    assert.equal(updateResult.failedStep, undefined);
    assert.equal(updateResult.rollbackOutcome, undefined);
    if (updateResult.run) assert.equal(updateResult.run.status, "succeeded");
    assert.ok(Array.isArray(updateResult.steps) && updateResult.steps.length > 0);
    assert.ok(updateResult.steps.some((step) => step.command.includes(coreTarball)), "the released updater must actually install the candidate archive, not skip/no-op");
    for (const step of updateResult.steps) {
      assert.equal(step.exitCode, 0, `updater step ${step.name} must complete`);
      assert.ok(!step.signal && !step.killed && !step.outputLimitExceeded);
      assert.ok(!step.termination || step.termination === "exit");
    }
    assert.equal(await fs.realpath(updateResult.root), await fs.realpath(coreRoot));
    receipt.candidateCoreIdentity = await compareInstalled("candidate-core-installed", candidateCore, coreRoot);
    await snapshot("after-core-upgrade");
    const pluginUpdate = updateResult.postUpdate?.plugins;
    assert.ok(pluginUpdate, "installed updater must retain its plugin-update outcome");
    assert.equal(pluginUpdate.status, "ok");
    assert.deepEqual(pluginUpdate.integrityDrifts, []);
    assert.deepEqual(pluginUpdate.sync.errors, []);
    assert.deepEqual(pluginUpdate.sync.warnings, []);
    assert.deepEqual(pluginUpdate.warnings ?? [], []);
    for (const outcome of pluginUpdate.npm.outcomes) {
      assert.notEqual(outcome.status, "error");
      if (outcome.pluginId === "searxng") {
        assert.ok(!outcome.nextVersion || outcome.nextVersion === "2026.10.3", "core updater must not select the incompatible 2026.10.4 plugin");
      }
    }
    receipt.postCoreStablePluginIdentity = await inspectPlugin("post-core-stable-plugin-inspect", stablePlugin);
  }
  // Reinstall the reviewed local package via its canonical owner, preserving existing activation.
  // No capability acceptance flag: unchanged accepted surfaces must be reused or the proof stops.
  successful(await run("install-candidate-plugin", cliBin, ["plugins", "install", `npm-pack:${pluginTarball}`, "--force", "--no-enable"], 600_000));
  await snapshot(coreUpgrade ? "after-plugin-upgrade" : "after-plugin-replacement");
  receipt.candidatePluginIdentity = await inspectPlugin("candidate-plugin-inspect", candidatePlugin);
  const candidateValidation = await json(successful(await run("candidate-config-validate", cliBin, ["config", "validate", "--json"])));
  assert.equal(candidateValidation.valid, true);
  await searches("candidate");
  await snapshot("after-candidate-searches");
  receipt.finalCoreIdentity = await compareInstalled(coreUpgrade ? "candidate-core-final" : "stable-core-unchanged-final", coreUpgrade ? candidateCore : stableCore, coreRoot);
  receipt.completed = true;
} catch (error) {
  receipt.errors.push({ name: error.name, message: error.message });
} finally {
  for (const [child, call] of activeChildren) {
    try { await stopChild(child, call); }
    catch (error) { receipt.errors.push({ name: "ChildCleanupError", message: error.message, case: call.name }); }
  }
  for (const timer of responseTimers) clearTimeout(timer);
  responseTimers.clear();
  try {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    receipt.serverClosed = true;
    if (receipt.fixturePort) {
      const probe = http.createServer();
      try {
        await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(receipt.fixturePort, "127.0.0.1", resolve); });
        receipt.fixturePortRebound = true;
      } finally { await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve())); }
    }
  } catch (error) { receipt.errors.push({ name: "ServerCleanupError", message: error.message }); }
  // Preserve the final authored state even on an earlier install/update failure.
  try { await snapshot("final-state", false); }
  catch (error) { receipt.errors.push({ name: "FinalConfigCaptureError", message: error.message }); }
  try {
    receipt.allOwnedProcessGroupsGone = [...activeChildren.keys()].every((child) => !child.pid || !groupExists(child.pid));
    assert.equal(receipt.allOwnedProcessGroupsGone, true, "preserve fixture if any child group remains active");
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith("searxng-installed-upgrade-"));
    await fs.rm(fixture, { recursive: true });
    receipt.fixtureRemoved = true;
  } catch (error) { receipt.errors.push({ name: "FixtureCleanupError", message: error.message }); }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
assert.deepEqual(receipt.errors, [], "installed-upgrade proof must not contain fixture, install, update, capture, or cleanup errors");
assert.deepEqual(receipt.behaviorFailures, []);
assert.equal(receipt.stableBaselineObserved, true);
assert.equal(receipt.completed, true);
assert.equal(receipt.coreUpdaterInvoked, coreUpgrade);
assert.equal(receipt.calls.some((call) => call.name === "stable-installed-updater"), coreUpgrade);
assert.equal(receipt.requests.length, 6);
assert.ok(receipt.calls.every((call) => call.processGroupGone && !call.watchdogFired && !call.forcedKill));
assert.equal(receipt.serverClosed, true);
assert.equal(receipt.fixturePortRebound, true);
assert.equal(receipt.allOwnedProcessGroupsGone, true);
assert.equal(receipt.fixtureRemoved, true);
console.log(coreUpgrade
  ? "PASS: published 2026.10.3 installed updater and canonical plugin replacement preserved authored defaults; installed candidate count/override/real-request timeout passed"
  : "PASS: published latest 2026.10.4 core remained byte-identical while canonical e9 candidate plugin 2026.10.3 replacement preserved authored defaults; count/override/real-request timeout passed; no core updater executed");
