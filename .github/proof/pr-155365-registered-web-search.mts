import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const [{ createBraveWebSearchProvider }, { createWebSearchTool }, registryModule, runtimeModule] =
  await Promise.all([
    import(
      pathToFileURL(path.join(root, "extensions/brave/src/brave-web-search-provider.ts")).href
    ),
    import(pathToFileURL(path.join(root, "src/agents/tools/web-search.ts")).href),
    import(pathToFileURL(path.join(root, "src/plugins/registry-empty.ts")).href),
    import(pathToFileURL(path.join(root, "src/plugins/runtime.ts")).href),
  ]);
const { createEmptyPluginRegistry } = registryModule;
const { setActivePluginRegistry } = runtimeModule;

const requests: Array<{ authorization: string | undefined; url: string }> = [];
const server = createServer((request, response) => {
  requests.push({
    authorization: request.headers["x-subscription-token"],
    url: request.url ?? "",
  });
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      web: {
        results: [
          {
            title: "Impossible",
            url: "https://example.com/impossible",
            description: "invalid calendar date",
            page_age: "2026-02-30",
          },
          {
            title: "Leap day",
            url: "https://example.com/leap",
            description: "valid leap day",
            page_age: "2000-02-29",
          },
          {
            title: "Offset",
            url: "https://example.com/offset",
            description: "valid timestamp suffix",
            page_age: "2024-02-29T00:30:00+14:00",
          },
        ],
      },
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;

try {
  const registry = createEmptyPluginRegistry();
  registry.webSearchProviders.push({
    pluginId: "brave",
    pluginName: "Brave",
    source: "proof",
    provider: createBraveWebSearchProvider(),
  });
  setActivePluginRegistry(registry);
  const config = {
    tools: { web: { search: { provider: "brave", cacheTtlMinutes: 0 } } },
    plugins: {
      entries: {
        brave: {
          config: {
            webSearch: {
              apiKey: "synthetic-proof-key",
              baseUrl: `http://127.0.0.1:${address.port}`,
            },
          },
        },
      },
    },
  };
  const tool = createWebSearchTool({ config });
  assert(tool, "registered web_search tool must exist");
  assert.equal(tool.name, "web_search");
  const result = await tool.execute("publication-proof", {
    query: "publication date boundary proof",
    count: 3,
  });
  const details = result.details as {
    count: number;
    kind: string;
    provider: string;
    results: Array<Record<string, unknown>>;
  };
  const observed = details.results.map(({ title, url, snippet, published }) => ({
    published,
    snippet,
    title,
    url,
  }));

  assert.equal(details.kind, "results");
  assert.equal(details.provider, "brave");
  assert.equal(details.count, 3);
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? "", /^\/res\/v1\/web\/search\?/u);
  assert.match(requests[0]?.url ?? "", /q=publication\+date\+boundary\+proof/u);
  assert.equal(requests[0]?.authorization, "synthetic-proof-key");
  assert.deepEqual(
    observed.map(({ url }) => url),
    ["https://example.com/impossible", "https://example.com/leap", "https://example.com/offset"],
  );
  assert(
    observed.every(
      ({ title, snippet }) => typeof title === "string" && typeof snippet === "string",
    ),
  );
  assert.equal(observed[1]?.published, "2000-02-29");
  assert.equal(observed[2]?.published, "2024-02-29T00:30:00+14:00");
  const expectDropped = process.env.EXPECT_INVALID_DROPPED === "1";
  assert.equal(observed[0]?.published, expectDropped ? undefined : "2026-02-30");

  const receipt = {
    exactSha: process.env.PROOF_EXACT_SHA,
    expectation: expectDropped ? "invalid publication omitted" : "invalid publication retained",
    nativeHttpRequests: requests.map(({ url }) => url),
    node: process.version,
    observed: observed.map(({ published, url }) => ({ published, url })),
    registeredTool: tool.name,
    resultCount: details.count,
  };
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  process.stdout.write(serialized);
  if (process.env.PROOF_OUTPUT) {
    await writeFile(process.env.PROOF_OUTPUT, serialized, "utf8");
  }
} finally {
  setActivePluginRegistry(createEmptyPluginRegistry());
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
