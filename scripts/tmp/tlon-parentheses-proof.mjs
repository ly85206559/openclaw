import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Temporary secretless proof tooling; intentionally excluded from the product PR.
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const expectation = option("--expect");
assert.ok(["baseline", "fixed"].includes(expectation), "--expect baseline|fixed required");
const output = path.resolve(option("--out") ?? ".tlon-proof");
await fs.mkdir(output, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reportPath = option("--test-report");
if (reportPath) {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults ?? []);
  const failures = assertions.filter((test) => test.status === "failed");
  assert.equal(report.testResults.length, 1, "only the complete story owner file is selected");
  assert.match(report.testResults[0].name, /extensions\/tlon\/src\/urbit\/story\.test\.ts$/);
  assert.equal(report.success, expectation === "fixed");
  assert.ok(report.numTotalTests > 4, "must collect the complete owner test file");
  assert.equal(assertions.length, report.numTotalTests);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
  assert.equal(report.numUnhandledErrors ?? 0, 0);
  assert.deepEqual(report.unhandledErrors ?? [], []);
  assert.equal(report.numFailedTests, expectation === "baseline" ? 4 : 0);
  assert.equal(failures.length, report.numFailedTests);
  assert.equal(report.numPassedTests, report.numTotalTests - failures.length);
  const needles = [
    "Function_(mathematics)",
    "[nested](https://example.com/a(b(c(d)e)f))",
    "diagram_(final).png",
    "a(b(c(d)e)f).png",
  ];
  if (expectation === "baseline") {
    for (const needle of needles) {
      const matches = failures.filter((test) => test.fullName.includes(needle));
      assert.equal(matches.length, 1, `exactly one assertion failure for ${needle}`);
      assert.ok(matches[0].failureMessages.length > 0);
      assert.match(matches[0].failureMessages.join("\n"), /AssertionError|expected.*equal/s);
    }
  }
  console.log(JSON.stringify({ expectation, collected: assertions.length, failures: failures.map((test) => test.fullName) }));
  process.exit(0);
}

const link = (href, content) => ({ link: { href, content } });
const inline = (...items) => ({ inline: items });
const image = (src, alt) => ({ block: { image: { src, alt, height: 0, width: 0 } } });
const math = "https://en.wikipedia.org/wiki/Function_(mathematics)";
const nested = "https://example.com/a(b(c(d)e)f)";
const diagram = "https://example.com/diagram_(final).png";
const nestedImage = "https://example.com/a(b(c(d)e)f).png";
const cases = [
  { name: "labeled-balanced", text: `See [math](${math})!`, baseline: [inline("See ", link("https://en.wikipedia.org/wiki/Function_(mathematics", "math"), ")!")], fixed: [inline("See ", link(math, "math"), "!")] },
  { name: "labeled-nested", text: `[nested](${nested})`, baseline: [inline(link("https://example.com/a(b(c(d", "nested"), "e)f))")], fixed: [inline(link(nested, "nested"))] },
  { name: "image-balanced", text: `![diagram](${diagram})`, baseline: [inline(".png)"), image("https://example.com/diagram_(final", "diagram")], fixed: [image(diagram, "diagram")] },
  { name: "image-nested", text: `![diagram](${nestedImage})`, baseline: [inline("e)f).png)"), image("https://example.com/a(b(c(d", "diagram")], fixed: [image(nestedImage, "diagram")] },
  { name: "simple-link", text: "[site](https://example.com)", fixed: [inline(link("https://example.com", "site"))] },
  { name: "simple-image", text: "![diagram](https://example.com/diagram.png)", fixed: [image("https://example.com/diagram.png", "diagram")] },
  { name: "inline-code", text: `\`[math](${math})\``, fixed: [inline({ "inline-code": `[math](${math})` })] },
  { name: "encoded-link", text: "[math](https://example.com/x%28y%29)", fixed: [inline(link("https://example.com/x%28y%29", "math"))] },
  { name: "encoded-image", text: "![diagram](https://example.com/x%28y%29.png)", fixed: [image("https://example.com/x%28y%29.png", "diagram")] },
  { name: "bare-balanced-and-punctuation", text: `see ${math}. Or (${math})!`, fixed: [inline("see ", link(math, math), ". Or (", link(math, math), ")!")] },
  { name: "empty-alt", text: "![](https://example.com/chart.png)", fixed: [image("https://example.com/chart.png", "")] },
  { name: "simple-link-punctuation", text: "([site](https://example.com))!", fixed: [inline("(", link("https://example.com", "site"), ")!")] },
];
const targets = [
  { name: "dm", to: "~nec" },
  { name: "group", to: "chat/~nec/general" },
  { name: "thread", to: "chat/~nec/general", thread: "1700000000000" },
];
const sourceFiles = ["extensions/tlon/src/urbit/story.ts", "extensions/tlon/src/urbit/story.test.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await fs.readFile(file))])));
const summary = { expectation, sourceSha: process.env.PROOF_SOURCE_SHA, sourceHashes, harnessSha256: sha256(await fs.readFile(process.argv[1])), node: process.version, boundary: "built CLI to synthetic Urbit HTTP; not live Urbit rendering", cases: [], cleanup: [] };

async function runCommand(args, env) {
  const started = Date.now();
  const child = spawn("pnpm", args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  let forceKill;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      // run-node owns a detached CLI child and forwards termination before joining it.
      process.kill(-child.pid, "SIGTERM");
      forceKill = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }, 10_000);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 120_000);
  try {
    const [code, signal] = await once(child, "close");
    return { command: ["pnpm", ...args], code, signal, timedOut, elapsedMs: Date.now() - started, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
  }
}

async function verifyBuiltTlon(coverageDir) {
  const scripts = [];
  for (const file of await fs.readdir(coverageDir)) {
    const coverage = JSON.parse(await fs.readFile(path.join(coverageDir, file), "utf8"));
    scripts.push(...coverage.result.filter((script) => script.functions.some((fn) => fn.ranges.some((range) => range.count > 0))));
  }
  const tlon = scripts.filter((script) => /\/extensions\/tlon\//.test(script.url));
  assert.ok(tlon.some((script) => /\/(dist|dist-runtime)\/extensions\/tlon\/.*\.(?:js|mjs|cjs)$/.test(script.url)), "must execute the genuine built registered Tlon plugin");
  assert.ok(!tlon.some((script) => script.url.endsWith(".ts")), "source-only Tlon fallback is not shipped-entry proof");
  const parser = tlon.flatMap((script) => script.functions.filter((fn) => /markdownToStory|parseInlineMarkdown/.test(fn.functionName) && fn.ranges.some((range) => range.count > 0)).map((fn) => ({ url: script.url, function: fn.functionName, ranges: fn.ranges })));
  assert.ok(parser.length > 0, "coverage must show the built story owner executing");
  for (const witness of parser) witness.artifactSha256 = sha256(await fs.readFile(fileURLToPath(witness.url)));
  return parser;
}

for (const target of targets) {
  for (const test of cases) {
    const id = `${target.name}-${test.name}`;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tlon-parentheses-proof-"));
    const requests = [];
    const errors = [];
    let record = { id, text: test.text, requests };
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        try {
          requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie, body });
          if (request.method === "POST" && request.url === "/~/login") {
            assert.equal(new URLSearchParams(body).get("password"), "mock-code");
            response.writeHead(200, { "set-cookie": "urbauth-~zod=mock-cookie" });
            response.end("ok");
          } else if (request.method === "PUT" && request.url.startsWith("/~/channel/")) {
            assert.equal(request.headers.cookie, "urbauth-~zod=mock-cookie");
            response.writeHead(204);
            response.end();
          } else {
            throw new Error(`unexpected HTTP route ${request.method} ${request.url}`);
          }
        } catch (error) {
          errors.push(String(error));
          response.writeHead(400);
          response.end("invalid synthetic request");
        }
      });
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const configPath = path.join(temporary, "openclaw.json");
      const coverageDir = path.join(temporary, "coverage");
      await fs.mkdir(coverageDir, { recursive: true });
      await fs.mkdir(path.join(temporary, "workspace"));
      await fs.writeFile(configPath, JSON.stringify({
        agents: { entries: { main: { workspace: path.join(temporary, "workspace") } } },
        plugins: { allow: ["tlon"], entries: { tlon: { enabled: true } }, slots: { memory: "none" } },
        channels: { tlon: { enabled: true, ship: "~zod", url: `http://127.0.0.1:${server.address().port}`, code: "mock-code", network: { dangerouslyAllowPrivateNetwork: true } } },
      }));
      // Deliberately do not inherit tokens, service credentials, or runner state.
      const env = { PATH: process.env.PATH, COREPACK_HOME: process.env.COREPACK_HOME, HOME: temporary, TMPDIR: temporary, LANG: "C.UTF-8", CI: "true", OPENCLAW_STATE_DIR: path.join(temporary, "state"), OPENCLAW_CONFIG_PATH: configPath, NODE_V8_COVERAGE: coverageDir };
      const args = ["--silent", "openclaw", "message", "send", "--channel", "tlon", "--target", target.to, "--message", test.text, "--json"];
      if (target.thread) args.push("--thread-id", target.thread);
      record = { ...record, command: await runCommand(args, env) };
      assert.equal(record.command.timedOut, false);
      assert.equal(record.command.code, 0, record.command.stderr);
      assert.equal(record.command.signal, null);
      assert.deepEqual(errors, []);
      assert.equal(requests.filter((request) => request.url === "/~/login").length, 1);
      const puts = requests.filter((request) => request.method === "PUT");
      assert.equal(puts.length, 1, "exactly one real poke per short send");
      const payload = JSON.parse(puts[0].body);
      assert.equal(payload.length, 1);
      const poke = payload[0];
      assert.equal(poke.action, "poke");
      assert.equal(poke.ship, "zod");
      let memo;
      if (target.name === "dm") {
        assert.equal(poke.app, "chat");
        assert.equal(poke.mark, "chat-dm-action");
        assert.equal(poke.json.ship, "~nec");
        memo = poke.json.diff.delta.add.memo;
      } else {
        assert.equal(poke.app, "channels");
        assert.equal(poke.mark, "channel-action-1");
        assert.equal(poke.json.channel.nest, "chat/~nec/general");
        const post = poke.json.channel.action.post;
        if (target.thread) {
          assert.equal(post.reply.id, "1.700.000.000.000");
          memo = post.reply.action.add;
        } else memo = post.add;
      }
      assert.equal(memo.author, "~zod");
      const expected = expectation === "baseline" ? (test.baseline ?? test.fixed) : test.fixed;
      assert.deepEqual(memo.content, expected);
      record.memo = memo;
      record.builtParser = await verifyBuiltTlon(coverageDir);
      record.status = "passed";
    } catch (error) {
      record.status = "failed";
      record.error = String(error.stack ?? error);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await fs.rm(temporary, { recursive: true, force: true });
      summary.cleanup.push({ id, loopbackClosed: !server.listening, isolatedStateRemoved: true });
      summary.cases.push(record);
      await fs.writeFile(path.join(output, `${id}.json`), JSON.stringify(record, null, 2));
      console.log(JSON.stringify({ id, status: record.status, commandExit: record.command?.code, error: record.error }));
    }
  }
}
for (const file of sourceFiles) assert.equal(sha256(await fs.readFile(file)), sourceHashes[file], `source drift: ${file}`);
await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
assert.equal(summary.cases.filter((record) => record.status === "failed").length, 0, "all built CLI / HTTP / negative-control / cleanup gates must pass");
