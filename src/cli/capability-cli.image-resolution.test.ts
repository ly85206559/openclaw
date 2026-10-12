import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerImageCapabilityCommands } from "./capability-cli/image.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  resolveLocalCapabilityAgent:
    vi.fn<typeof import("./capability-cli/shared.js").resolveLocalCapabilityAgent>(),
  generateImage: vi.fn<typeof import("../image-generation/runtime.js").generateImage>(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

// mock-isolation: Keep config and credential reads outside this CLI admission contract.
vi.mock("./capability-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-cli/shared.js")>()),
  resolveLocalCapabilityAgent: mocks.resolveLocalCapabilityAgent,
}));

// mock-isolation: Return a controlled image without contacting a billed provider.
vi.mock("../image-generation/runtime.js", () => ({
  generateImage: mocks.generateImage,
}));

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLocalCapabilityAgent.mockResolvedValue({
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/image-resolution-agent",
  });
});

async function imageFixture() {
  const directory = tempDirs.make("capability-image-resolution-");
  const inputPath = path.join(directory, "input.png");
  const outputPath = path.join(directory, "output.png");
  const png = Buffer.from(PNG_1X1_BASE64, "base64");
  await fs.writeFile(inputPath, png);
  mocks.generateImage.mockResolvedValue({
    provider: "openai",
    model: "gpt-image-1.5",
    attempts: [],
    images: [{ buffer: png, mimeType: "image/png", fileName: "output.png" }],
  });
  return { inputPath, outputPath, png };
}

async function runImage(action: string, ...options: string[]) {
  const program = new Command().exitOverride();
  registerImageCapabilityCommands(program);
  await program.parseAsync(
    ["image", action, "--prompt", "friendly lobster", ...options, "--json"],
    { from: "user" },
  );
}

describe("image CLI resolution", () => {
  it.each([
    ["generate", "1080p"],
    ["edit", "1080p"],
    ["generate", "8K"],
    ["edit", "8K"],
  ])("rejects image %s resolution %s before dispatch", async (action, resolution) => {
    const { inputPath, outputPath } = await imageFixture();

    await expect(
      runImage(
        action,
        ...(action === "edit" ? ["--file", inputPath] : []),
        "--resolution",
        resolution,
        "--output",
        outputPath,
      ),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(
      "--resolution must be one of 1K, 2K, or 4K",
    );
    expect(mocks.resolveLocalCapabilityAgent).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { supplied: undefined, expected: undefined },
    { supplied: "1K", expected: "1K" },
    { supplied: " 2k ", expected: "2K" },
  ])("forwards canonical image resolution $expected", async ({ supplied, expected }) => {
    const { outputPath, png } = await imageFixture();

    await runImage(
      "generate",
      ...(supplied === undefined ? [] : ["--resolution", supplied]),
      "--output",
      outputPath,
    );

    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.generateImage.mock.calls[0]?.[0].resolution).toBe(expected);
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: true,
        capability: "image.generate",
        outputs: [expect.objectContaining({ path: outputPath, mimeType: "image/png" })],
      }),
      2,
    );
    expect(await fs.readFile(outputPath)).toEqual(png);
  });
});
