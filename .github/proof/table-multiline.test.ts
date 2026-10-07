// Fork-only proof: materialize at src/cli/plugins-list-command.multiline-proof.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { renderTable } from "../../packages/terminal-core/src/table.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { runPluginsListCommand } from "./plugins-list-command.js";

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");

const fixture = vi.hoisted(() => ({
  plugin: {
    id: "N".repeat(40),
    name: "N".repeat(40),
    source: `/tmp/${"s".repeat(25)}`,
    origin: "config",
    format: "openclaw",
    enabled: true,
    status: "loaded",
    description: "d".repeat(30),
    version: "2026.9.8",
    providerIds: [],
    agentHarnessIds: [],
  },
}));

// mock-isolation: Avoid operator configuration and plugin state while rendering a synthetic inventory.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: Supply only inventory facts; the command, source formatter, theme and table stay real.
vi.mock("../plugins/status-snapshot.js", () => ({
  buildPluginRegistrySnapshotReport: () => ({
    workspaceDir: "/tmp/proof-workspace",
    workspaceScope: "selected",
    registrySource: "config",
    registryDiagnostics: [],
    diagnostics: [],
    plugins: [fixture.plugin],
  }),
}));

function createRuntime(writes: unknown[]): OutputRuntimeEnv {
  return {
    log: (...args: unknown[]) => writes.push(args.length === 1 ? args[0] : args),
    error: (error: unknown) => {
      throw new Error(String(error));
    },
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
    writeStdout: (value: string) => writes.push(value),
    writeJson: (value: unknown) => writes.push(value),
  };
}

describe("plugins list multiline downstream proof", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 122 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalColumns) {
      Object.defineProperty(process.stdout, "columns", originalColumns);
    } else {
      Reflect.deleteProperty(process.stdout, "columns");
    }
    fixture.plugin.description = "d".repeat(30);
  });

  it.each<[label: string, description: string, expectedRows: number]>([
    ["multiline source", "d".repeat(30), 2],
    ["single-line source control", "", 1],
  ])("keeps the plugin name intact with %s", async (label, description, expectedRows) => {
    fixture.plugin.description = description;
    const writes: unknown[] = [];

    await runPluginsListCommand({}, createRuntime(writes));

    const table = stripAnsi(String(writes.at(-1)));
    const rows = table.split("\n").slice(3, -1).map((line) => line.split("│").slice(1, -1));
    console.log("TABLE_MULTILINE_PROOF", JSON.stringify({ label, rows, table }));
    expect(rows).toHaveLength(expectedRows);
    expect(rows[0]?.[0]?.trim()).toBe("N".repeat(40));
    expect(rows[0]?.[4]?.trim()).toBe(`/tmp/${"s".repeat(25)}`);
    if (description) {
      expect(rows[1]?.[0]?.trim()).toBe("");
      expect(rows[1]?.[4]?.trim()).toBe("d".repeat(30));
    }
  });

  it("keeps complete metadata in JSON and verbose controls", async () => {
    const jsonWrites: unknown[] = [];
    await runPluginsListCommand({ json: true }, createRuntime(jsonWrites));
    expect(jsonWrites).toEqual([
      expect.objectContaining({
        plugins: [
          expect.objectContaining({
            id: "N".repeat(40),
            source: `/tmp/${"s".repeat(25)}`,
            description: "d".repeat(30),
          }),
        ],
      }),
    ]);

    const verboseWrites: unknown[] = [];
    await runPluginsListCommand({ verbose: true }, createRuntime(verboseWrites));
    const verbose = stripAnsi(String(verboseWrites.at(-1)));
    expect(verbose).toContain("N".repeat(40));
    expect(verbose).toContain(`/tmp/${"s".repeat(25)}`);
  });

  it.each([
    ["ASCII", "abcdef", "+--------+\n| V      |\n+--------+\n| abcdef |\n+--------+\n"],
    ["edge spacing", " abc ", "+-------+\n| V     |\n+-------+\n| abc   |\n+-------+\n"],
    [
      "colored ASCII",
      "\x1b[31mabcdef\x1b[39m",
      "+--------+\n| V      |\n+--------+\n| abcdef |\n+--------+\n",
    ],
  ])("preserves %s single-line width control", (_label, value, expected) => {
    expect(stripAnsi(renderTable({
      border: "ascii",
      columns: [{ key: "V", header: "V" }],
      rows: [{ V: value }],
    }))).toBe(expected);
  });
});
