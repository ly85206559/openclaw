import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  clearActiveDegradedPlugin,
  findActiveDegradedPlugin,
  listActiveDegradedPlugins,
  pluginInstallPathMatchesRoot,
  setActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "./runtime-degraded-state.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

describe("pluginInstallPathMatchesRoot", () => {
  it("matches an existing plugin root through a symlink alias", () => {
    if (process.platform === "win32") {
      return;
    }

    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const pluginRoot = path.join(baseDir, "plugin");
      const pluginAlias = path.join(baseDir, "plugin-alias");
      fs.mkdirSync(pluginRoot);
      fs.symlinkSync(pluginRoot, pluginAlias, "dir");

      expect(pluginInstallPathMatchesRoot(pluginAlias, pluginRoot)).toBe(true);
    });
  });

  it("falls back to absolute lexical paths when plugin roots are missing", () => {
    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const missingRoot = path.join(baseDir, "missing-plugin");
      const equivalentMissingRoot = path.join(baseDir, "nested", "..", "missing-plugin");

      expect(pluginInstallPathMatchesRoot(equivalentMissingRoot, missingRoot)).toBe(true);
      expect(pluginInstallPathMatchesRoot(path.join(baseDir, "other-missing"), missingRoot)).toBe(
        false,
      );
    });
  });
});

describe("toPublicPluginVerificationDiagnostic", () => {
  it("redacts credentials before bounding public detail", () => {
    const registeredFixture = "fixture-only-public-diagnostic-value";
    registerSecretValueForRedaction(registeredFixture);
    const diagnostic = toPublicPluginVerificationDiagnostic({
      kind: "plugin-verification",
      reason: "invalid-package-json",
      detail: `${registeredFixture} ${"x".repeat(1_200)}`,
    });

    expect(diagnostic.detail).not.toContain(registeredFixture);
    expect(diagnostic.detail.length).toBeLessThanOrEqual(1_000);
  });

  it("does not split a surrogate pair at the public detail limit", () => {
    const diagnostic = toPublicPluginVerificationDiagnostic({
      kind: "plugin-verification",
      reason: "invalid-package-json",
      detail: `${"x".repeat(999)}😀`,
    });

    expect(diagnostic.detail).toHaveLength(999);
    expect(diagnostic.detail).not.toMatch(/[\uD800-\uDFFF]$/u);
  });
});

it("keeps quarantine snapshots stable across caller edits, replacement, and clearing", () => {
  const previous = listActiveDegradedPlugins();
  try {
    const plugins = buildDegradedPluginsFromVerificationFailures([
      { pluginId: "example", reason: "missing-package-json", detail: "package.json is missing" },
    ]);
    setActiveDegradedPlugins(plugins);
    const snapshot = listActiveDegradedPlugins();

    plugins.length = 0;
    expect(listActiveDegradedPlugins()).toHaveLength(1);

    setActiveDegradedPlugins(
      buildDegradedPluginsFromVerificationFailures([
        { pluginId: "example", reason: "missing-main-entry", detail: "main entry is missing" },
      ]),
    );
    expect(findActiveDegradedPlugin("example")?.diagnostic.reason).toBe("missing-main-entry");
    expect(snapshot.map((plugin) => plugin.diagnostic.reason)).toEqual(["missing-package-json"]);

    clearActiveDegradedPlugin("example");
    expect(findActiveDegradedPlugin("example")).toBeUndefined();
    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(snapshot.map((plugin) => plugin.diagnostic.reason)).toEqual(["missing-package-json"]);
  } finally {
    setActiveDegradedPlugins(previous);
  }
});
