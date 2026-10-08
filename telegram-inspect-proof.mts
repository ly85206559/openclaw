import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const loads = new Set<string>();
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith("file:")) {
      loads.add(fileURLToPath(url));
    }
    return result;
  },
});

function miniAppReceipt() {
  return [...new Set([...loads, ...Object.keys(require.cache).filter((p) => require.cache[p]?.loaded)])]
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => /\/extensions\/telegram\/(?:miniapp-api\.[cm]?[jt]s|src\/miniapp\/)/u.test(p))
    .sort();
}

const cfg = {
  channels: { telegram: { botToken: "inspection-only-token" } },
  plugins: {
    allow: ["telegram"],
    entries: { telegram: { enabled: true } },
    slots: { memory: "none" },
  },
};
const { inspectReadOnlyChannelAccount } = await import("./src/channels/read-only-account-inspect.js");
assert.deepEqual(miniAppReceipt(), [], "proof preloaded Mini App runtime");
const account = await inspectReadOnlyChannelAccount({ channelId: "telegram", cfg, accountId: "default" });
assert(account, "actual read-only facade did not return an account");
const observed = {
  accountId: account.accountId,
  configured: account.configured,
  enabled: account.enabled,
  tokenSource: account.tokenSource,
  tokenStatus: account.tokenStatus,
  mode: account.mode,
};
assert.deepEqual(observed, {
  accountId: "default", configured: true, enabled: true,
  tokenSource: "config", tokenStatus: "available", mode: "polling",
});
const inspectionReceipt = miniAppReceipt();
console.log(JSON.stringify({ phase: "actual-account-inspection", result: observed, miniAppReceipt: inspectionReceipt }));
assert.equal(inspectionReceipt.length === 0, process.env.EXPECTED_LAZY === "1", "inspection load boundary differs from expected variant");

const control = process.argv[2] ?? "tool-discovery";
assert(["tool-discovery", "full"].includes(control));
const { loadOpenClawPlugins } = await import("./src/plugins/loader.js");
const { disposePluginRegistryInstances } = await import("./src/plugins/runtime.js");
const registry = loadOpenClawPlugins({
  config: cfg, onlyPluginIds: ["telegram"], mode: "full",
  toolDiscovery: control === "tool-discovery", preferBuiltPluginArtifacts: false,
  activate: false, cache: false, runtimeSideEffects: false, throwOnLoadError: true,
});
try {
  const owner = registry.plugins.find((p) => p.id === "telegram");
  assert.equal(owner?.status, "loaded");
  assert.equal(owner?.origin, "bundled");
  const commands = registry.commands.filter((p) => p.pluginId === "telegram").map((p) => p.command.name);
  const routes = registry.httpRoutes.filter((p) => p.pluginId === "telegram").map((p) => ({ path: p.path, auth: p.auth, match: p.match }));
  assert(commands.includes("controlui"));
  assert(routes.some((p) => p.path === "/__openclaw_tg_miniapp/" && p.auth === "plugin" && p.match === "prefix"));
  assert(miniAppReceipt().length > 0, "registration control did not observe Mini App loading");
  console.log(JSON.stringify({ phase: control, owner: { id: owner?.id, origin: owner?.origin, status: owner?.status }, commands, routes, miniAppReceipt: miniAppReceipt() }));
} finally {
  const cleanup = await disposePluginRegistryInstances(registry);
  console.log(JSON.stringify({ phase: "cleanup", result: cleanup }));
  assert.deepEqual(cleanup.failures, []);
  hook.deregister();
}
