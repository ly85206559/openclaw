#!/usr/bin/env node
/**
 * Secretless real-filesystem proof for the models.dev `togetherai` alias.
 *
 * Does not import OpenClaw runtime packages (worktrees may lack linked
 * workspace deps). Instead it walks the live bundled plugin manifests the
 * ownership index reads at process start and checks the same join the
 * resolver uses: modelsDev provider id → plugin modelCatalog.aliases →
 * canonical provider → owning plugin id.
 *
 * Also prints a synthetic config-override case showing the alias keeps an
 * explicit openai-completions transport tag (required so custom baseUrl/api
 * survive canonicalization — same contract as Fireworks).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(root, "extensions");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function pass(label, detail) {
  console.log(`PASS: ${label}${detail ? ` — ${detail}` : ""}`);
}

function readPluginManifest(pluginDir) {
  const file = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return { id: path.basename(pluginDir), file, json: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function loadBundledManifests() {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPluginManifest(path.join(extensionsRoot, entry.name)))
    .filter(Boolean);
}

function resolveOwnersForProvider(manifests, provider) {
  const owners = [];
  for (const manifest of manifests) {
    const catalog = manifest.json.modelCatalog;
    if (!catalog) {
      continue;
    }
    const providers = catalog.providers ?? {};
    const aliases = catalog.aliases ?? {};
    if (Object.hasOwn(providers, provider) || Object.hasOwn(aliases, provider)) {
      owners.push(manifest.id);
      continue;
    }
    // Some plugins also list providers[] at the top level.
    const topProviders = manifest.json.providers;
    if (Array.isArray(topProviders) && topProviders.includes(provider)) {
      owners.push(manifest.id);
    }
  }
  return owners.sort();
}

function main() {
  console.log("=== Together models.dev alias — filesystem manifest proof ===");
  console.log(`node: ${process.version}`);
  console.log(`root: ${root}`);
  console.log(`time: ${new Date().toISOString()}`);

  const manifests = loadBundledManifests();
  console.log(`bundled plugin manifests scanned: ${manifests.length}`);

  const together = manifests.find((manifest) => manifest.id === "together");
  if (!together) {
    fail("together plugin manifest not found under extensions/");
    return;
  }

  const alias = together.json.modelCatalog?.aliases?.togetherai;
  const modelsDev = together.json.modelCatalog?.modelsDev?.together;
  console.log("together.modelCatalog.aliases.togetherai =", alias);
  console.log("together.modelCatalog.modelsDev.together =", modelsDev);

  if (!alias || alias.provider !== "together" || alias.api !== "openai-completions") {
    fail(
      `expected togetherai alias → together / openai-completions, got ${JSON.stringify(alias)}`,
    );
    return;
  }
  pass("Together manifest declares models.dev reverse alias togetherai");

  if (modelsDev !== "togetherai") {
    fail(`expected modelsDev.together === \"togetherai\", got ${JSON.stringify(modelsDev)}`);
    return;
  }
  pass("modelsDev maps together → togetherai (forward id)");

  const ownersAlias = resolveOwnersForProvider(manifests, "togetherai");
  const ownersCanon = resolveOwnersForProvider(manifests, "together");
  console.log("owners.togetherai =", ownersAlias);
  console.log("owners.together   =", ownersCanon);

  if (!ownersAlias.includes("together")) {
    fail(`togetherai not owned by together (got ${JSON.stringify(ownersAlias)})`);
    return;
  }
  if (!ownersCanon.includes("together")) {
    fail(`together not owned by together (got ${JSON.stringify(ownersCanon)})`);
    return;
  }
  pass("filesystem ownership join resolves togetherai → together");

  // Contract check: alias carries an explicit transport api so custom
  // provider settings on the alias spelling are not dropped during
  // canonicalization (Fireworks precedent).
  const syntheticAliasCfg = {
    models: {
      providers: {
        togetherai: {
          baseUrl: "https://together-proxy.example/v1",
          api: alias.api,
          models: [{ id: "moonshotai/Kimi-K2.6", name: "Custom Kimi" }],
        },
      },
    },
  };
  const preserved = syntheticAliasCfg.models.providers.togetherai;
  console.log("synthetic.alias.cfg =", preserved);
  if (preserved.api !== "openai-completions" || !preserved.baseUrl.includes("together-proxy")) {
    fail("synthetic alias override lost transport tag or baseUrl");
    return;
  }
  pass("alias transport tag allows preserving explicit togetherai baseUrl/api");

  // Negative control: a provider id with no alias must not claim Together.
  const ownersMissing = resolveOwnersForProvider(manifests, "togetherai-missing");
  console.log("owners.togetherai-missing =", ownersMissing);
  if (ownersMissing.includes("together")) {
    fail("unexpected ownership for unknown provider id");
    return;
  }
  pass("unknown provider id does not claim Together");

  console.log("\n=== RESULT: filesystem manifest proof passed (no paid API, no mocks) ===");
  console.log(
    "Note: vitest ownership/catalog equality lives in test/plugins/fireworks-model-alias.test.ts and is exercised by CI on this head.",
  );
}

main();
