import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { marked } from "marked";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  authenticateMock,
  inboundRuntimeMock,
  ingressMock,
  monitorTlonProvider,
  realUrbitFixture,
  settingsManagerMock,
} = useTlonMonitorFixture();

const nested = "Before\n```markdown\n# literal heading\n```\nAfter";
const ordinary = "const answer = 42;";

// Real login, Urbit HTTP and SSE; the shared fixture mocks durable ingress and
// downstream context/dispatch. This is not a live ship or a built Gateway.
it.each([
  { name: "DM nested code", group: false, code: nested },
  { name: "group nested code", group: true, code: nested },
  { name: "DM ordinary code", group: false, code: ordinary },
  { name: "group ordinary code", group: true, code: ordinary },
  { name: "DM plain text", group: false },
  { name: "group plain text", group: true },
  { name: "disallowed DM", group: false, denied: true },
])("captures $name at the inbound owner boundary", async ({ name, group, code, denied }) => {
  const controller = new AbortController();
  const scheduler = createTestPluginServiceScheduler();
  const wire: Array<{ method: string; path: string; body?: unknown }> = [];
  const subscriptions: Array<{ id: number; app: string }> = [];
  const channelNest = "chat/~host/general";
  let stream: ServerResponse | undefined;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const receipt = { method: req.method ?? "GET", path };
    wire.push(receipt);
    if (req.method === "POST" && path === "/~/login") {
      res.writeHead(200, { "Set-Cookie": "urbauth-~zod=synthetic-proof; Path=/" });
      res.end("ok");
    } else if (req.method === "GET" && path.startsWith("/~/scry/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } else if (req.method === "PUT" && path.startsWith("/~/channel/")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part: string) => { body += part; });
      req.on("end", () => {
        const actions = JSON.parse(body) as Array<{ id: number; app: string; action: string }>;
        Object.assign(receipt, { body: actions });
        subscriptions.push(...actions.filter((action) => action.action === "subscribe"));
        res.writeHead(204);
        res.end();
      });
    } else if (req.method === "GET" && path.startsWith("/~/channel/")) {
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": connected\n\n");
    } else if (req.method === "DELETE" && path.startsWith("/~/channel/")) {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  realUrbitFixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  realUrbitFixture.enabled = true;
  realUrbitFixture.config = {
    channels: { tlon: {
      code: "synthetic-proof", ship: "~zod", url: realUrbitFixture.url,
      network: { dangerouslyAllowPrivateNetwork: true }, dmAllowlist: ["~bus"],
      groupChannels: [channelNest],
      authorization: { channelRules: { [channelNest]: { mode: "open" } } },
    } },
  };
  settingsManagerMock.load.mockResolvedValueOnce({});
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  const actualAuth = await vi.importActual<typeof import("../urbit/auth.js")>("../urbit/auth.js");
  authenticateMock.mockImplementationOnce(actualAuth.authenticate);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const monitor = monitorTlonProvider({ scheduler, abortSignal: controller.signal, runtime });
  void monitor.catch(() => {});
  let message: unknown;
  let parser: unknown;
  try {
    await vi.waitFor(() => expect(ingressMock.start).toHaveBeenCalledOnce());
    const subscription = subscriptions.find((entry) => entry.app === (group ? "channels" : "chat"));
    expect(subscription).toBeDefined();
    const content = code === undefined
      ? [{ inline: [group ? "~zod plain control" : "plain control"] }]
      : [...(group ? [{ inline: ["~zod"] }] : []), { block: { code: { code, lang: "markdown" } } }];
    const sender = denied ? "~nec" : "~bus";
    const essay = { author: sender, content, sent: 1_700_000_000_000 };
    const json = group
      ? { nest: channelNest, response: { post: { id: "fence-proof", "r-post": { set: { essay } } } } }
      : { whom: sender, id: "fence-proof", response: { add: { essay } } };
    stream!.write(`id: 21\ndata: ${JSON.stringify({ id: subscription!.id, json })}\n\n`);
    await vi.waitFor(() => expect(wire.some((entry) => Array.isArray(entry.body) &&
      entry.body.some((action) => action["event-id"] === 21))).toBe(true));
    expect(runtime.error).not.toHaveBeenCalled();
    if (denied) {
      expect(inboundRuntimeMock.buildContext).not.toHaveBeenCalled();
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    } else {
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      message = inboundRuntimeMock.buildContext.mock.calls[0]?.[0].message;
      const body = inboundRuntimeMock.buildContext.mock.calls[0]?.[0].message.bodyForAgent;
      expect(typeof body).toBe("string");
      if (code === undefined) {
        expect(body).toBe("plain control");
      } else {
        parser = marked.lexer(body).filter((token) => token.type !== "space");
        if (code === ordinary) {
          expect(body).toBe("```markdown\nconst answer = 42;\n```");
        }
        expect(parser).toMatchObject([{ type: "code", lang: "markdown", text: code }]);
      }
    }
  } finally {
    controller.abort();
    await monitor;
    realUrbitFixture.client = null;
    await scheduler.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    console.log(JSON.stringify({ name, scope: "native Urbit HTTP/SSE with mocked ingress/context/dispatch", message, parser, wire,
      cleanup: { ingressStopped: ingressMock.stop.mock.calls.length, closedChannel: wire.some((entry) => entry.method === "DELETE") } }));
    expect(wire.some((entry) => entry.method === "DELETE")).toBe(true);
    expect(ingressMock.stop).toHaveBeenCalledOnce();
  }
});
