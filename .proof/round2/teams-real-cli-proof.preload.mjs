// Proof-only external I/O fixture; never load on a credentialed or local host.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "linux");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const repo = process.env.TEAMS_PROOF_REPO;
const output = process.env.TEAMS_PROOF_EVENTS;
assert.ok(repo && path.isAbsolute(repo));
assert.ok(output && path.isAbsolute(output));
assert.equal(fs.readlinkSync("/proc/self/ns/net"), process.env.TEAMS_PROOF_NETWORK_NAMESPACE);
const interfaces = fs.readFileSync("/proc/self/net/dev", "utf8").trim().split("\n")
  .slice(2).map((line) => line.split(":")[0].trim()).sort();
assert.deepEqual(interfaces, ["lo"]);
const endpoint = new URL(process.env.TEAMS_PROOF_GRAPH_ORIGIN ?? "");
assert.equal(endpoint.protocol, "http:");
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(endpoint.pathname, "/");
assert.equal(endpoint.search, "");
assert.equal(endpoint.username, "");
assert.equal(endpoint.password, "");
const token = "openclaw-teams-proof-not-a-real-token";
const tenantId = "55555555-5555-5555-5555-555555555555";
const writeEvent = (event) => fs.appendFileSync(output, `${JSON.stringify({ pid: process.pid, ...event })}\n`);

// Reach the same external CJS dependency as the real bundled plugin. Patch only
// the SDK's documented per-App token interface, not the Teams result producer.
const require = createRequire(pathToFileURL(path.join(repo, "extensions/msteams/package.json")));
const sdkModule = require.resolve("@microsoft/teams.apps");
const sdkPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdkModule), "../package.json"), "utf8"));
assert.equal(sdkPackage.version, "2.1.0");
const { App } = require("@microsoft/teams.apps");
const descriptor = Object.getOwnPropertyDescriptor(App.prototype, "tokenProvider");
assert.equal(typeof descriptor?.get, "function");
assert.equal(descriptor.configurable, true);
const originalTokenProvider = descriptor.get;
const prepared = new WeakSet();
Object.defineProperty(App.prototype, "tokenProvider", {
  ...descriptor,
  get() {
    const provider = originalTokenProvider.call(this);
    if (!prepared.has(provider)) {
      provider.getAppToken = async (scope, tenant) => {
        assert.equal(scope, "https://graph.microsoft.com/.default");
        assert.equal(tenant, tenantId);
        writeEvent({ kind: "external-token-fixture", scope, tenant });
        return { toString: () => token };
      };
      prepared.add(provider);
    }
    return provider;
  },
});
writeEvent({ kind: "preload", sdkVersion: sdkPackage.version, sdkModule, entry: process.argv[1] });

// Later native plugin alias resolvers short-circuit bare specifiers. Intercept
// only the physical URL selected by this verified public package export instead.
const hostRequire = createRequire(pathToFileURL(path.join(repo, "package.json")));
const hostPackage = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const publicSpecifier = "openclaw/plugin-sdk/ssrf-runtime";
const publicExport = hostPackage.exports["./plugin-sdk/ssrf-runtime"];
assert.equal(publicExport.default, "./dist/plugin-sdk/ssrf-runtime.js");
const publicModule = hostRequire.resolve(publicSpecifier);
assert.equal(fs.realpathSync(publicModule), fs.realpathSync(path.resolve(repo, publicExport.default)));
const publicUrl = pathToFileURL(fs.realpathSync(publicModule)).href;
const actualUrl = new URL(publicUrl);
actualUrl.searchParams.set("teams-proof-actual", "1");
writeEvent({ kind: "public-ssrf-export-resolved", specifier: publicSpecifier, original: publicUrl,
  actual: actualUrl.href });
// The query loads the unchanged facade once, retaining its canonical underlying
// imports; the bridge replaces only the external origin and re-exports the rest.
const bridge = `
import * as actual from ${JSON.stringify(actualUrl.href)};
export * from ${JSON.stringify(actualUrl.href)};
import { fetchGraphFixture } from ${JSON.stringify(import.meta.url)};
export const fetchWithSsrFGuard = (params) => fetchGraphFixture(actual, params);
`;
registerHooks({
  load(url, context, nextLoad) {
    if (url === publicUrl) {
      writeEvent({ kind: "public-ssrf-runtime-hook", specifier: publicSpecifier,
        original: publicUrl, actual: actualUrl.href, format: context.format });
      return { source: bridge, format: "module", shortCircuit: true };
    }
    if (url === actualUrl.href) {
      const loaded = nextLoad(url, context);
      writeEvent({ kind: "public-ssrf-actual-facade-loaded", original: publicUrl,
        actual: actualUrl.href, format: loaded.format });
      return loaded;
    }
    return nextLoad(url, context);
  },
});

export async function fetchGraphFixture(actual, params) {
  const source = new URL(params.url);
  assert.equal(source.origin, "https://graph.microsoft.com");
  assert.equal(params.init?.method ?? "GET", "GET");
  const target = new URL(`${source.pathname}${source.search}`, endpoint);
  writeEvent({ kind: "external-graph-origin-fixture", source: source.href, target: target.href });
  return await actual.fetchWithSsrFGuard({
    ...params,
    url: target.href,
    policy: actual.ssrfPolicyFromHttpBaseUrlAllowedOrigin(target.href),
    maxRedirects: 0,
  });
}
