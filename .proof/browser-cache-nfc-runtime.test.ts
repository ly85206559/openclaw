import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { decodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "../extensions/memory-core/src/memory/manager-index.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../src/state/openclaw-agent-db-lifecycle.js";
import { closeStateDatabaseForTest } from "../src/test-utils/database-cleanup.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import(
  "../extensions/memory-core/src/memory/index.js"
);
const { watch } = await import("openclaw/plugin-sdk/file-access-runtime");
const phase = process.env.OPENCLAW_PROOF_PHASE;
if (phase !== "red" && phase !== "green") {
  throw new Error("OPENCLAW_PROOF_PHASE must be red or green");
}

afterAll(async () => {
  await closeAllMemorySearchManagers();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  console.log(`NFC_RUNTIME_CLEANUP_OK phase=${phase}`);
});

describe("canonical CJK diversity through actual file sync and hybrid search", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([
    {
      name: "Hangul MMR on",
      primary: "각",
      duplicate: "\u1100\u1161\u11a8",
      diverse: "나",
      enabled: true,
    },
    {
      name: "Hangul MMR off",
      primary: "각",
      duplicate: "\u1100\u1161\u11a8",
      diverse: "나",
      enabled: false,
    },
    { name: "kana MMR on", primary: "が", duplicate: "か\u3099", diverse: "な", enabled: true },
    { name: "kana MMR off", primary: "が", duplicate: "か\u3099", diverse: "な", enabled: false },
  ])("$name", async ({ name, primary, duplicate, diverse, enabled }) => {
    // Saturate the existing length boost equally so MMR, not NFD byte length, decides diversity.
    const prefix = "nfcprobe alpha reference context notes ";
    const files = [
      { name: "a-primary.md", text: `${prefix}${primary}` },
      { name: "b-duplicate.md", text: `${prefix}${duplicate}` },
      { name: "c-diverse.md", text: `${prefix}${diverse}` },
    ];
    await fs.writeFile(path.join(fixture.paths.memory, "2026-01-12.md"), "unrelated fixture");
    for (const file of files) {
      await fs.writeFile(path.join(fixture.paths.memory, file.name), file.text);
    }
    const cfg = fixture.createConfig({
      provider: "openai",
      sources: ["memory"],
      vectorEnabled: false,
      minScore: 0.01,
    });
    const search = cfg.memory?.search;
    if (!search) {
      throw new Error("Expected the fixture's existing memory search configuration");
    }
    search.sync = { watch: false, onSearch: false, onSessionStart: false };
    search.query = {
      minScore: 0.01,
      hybrid: {
        enabled: true,
        vectorWeight: 0.7,
        textWeight: 0.3,
        mmr: { enabled, lambda: 0.7 },
        temporalDecay: { enabled: false },
      },
    };
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "test", force: true });
    expect(manager.status()).toMatchObject({ provider: "mock", fts: { available: true } });
    const results = await manager.search("nfcprobe alpha", { maxResults: 3, minScore: 0.01 });
    expect(fixture.provider.embeddedQueryTexts).toEqual(["nfcprobe alpha"]);
    expect(results).toHaveLength(3);
    expect(results.every((row) => row.vectorScore === 1 && (row.textScore ?? 0) > 0)).toBe(true);
    expect(new Set(results.map((row) => row.textScore)).size).toBe(1);
    console.log(`NFC_RUNTIME_TRACE ${JSON.stringify({ phase, name, results })}`);
    expect(new Set(results.map((row) => row.score)).size).toBe(1);
    const expected =
      enabled && phase === "green"
        ? ["memory/a-primary.md", "memory/c-diverse.md", "memory/b-duplicate.md"]
        : ["memory/a-primary.md", "memory/b-duplicate.md", "memory/c-diverse.md"];
    expect(results.map((row) => row.path)).toEqual(expected);
    const database = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const rows = database
      .prepare(
        "SELECT path, text, embedding FROM memory_index_chunks WHERE path IN (?, ?, ?) ORDER BY path",
      )
      .all(...files.map((file) => `memory/${file.name}`));
    expect(rows).toHaveLength(3);
    for (const [index, file] of files.entries()) {
      expect(rows[index]?.path).toBe(`memory/${file.name}`);
      expect(rows[index]?.text).toBe(file.text);
      const embedding = rows[index]?.embedding;
      expect(embedding).toBeInstanceOf(Uint8Array);
      if (!(embedding instanceof Uint8Array)) {
        throw new Error("Expected a persisted embedding BLOB");
      }
      expect(decodeMemoryEmbedding(embedding)).toEqual([1, 0, 0, 0]);
      expect(await fs.readFile(path.join(fixture.paths.memory, file.name))).toEqual(
        Buffer.from(file.text),
      );
      expect(results.find((row) => row.path === `memory/${file.name}`)?.snippet).toBe(file.text);
    }
    // The reused fixture registers an observation mock; this flow does not invoke it.
    expect(watch).not.toHaveBeenCalled();
    console.log(
      `NFC_RUNTIME_CASE_OK ${JSON.stringify({ phase, name, paths: expected, rawBytesPreserved: true })}`,
    );
  });
});
