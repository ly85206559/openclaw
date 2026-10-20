// External proof controller only; never include this file in the product PR.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { listChannelPairingRequests } from "../../../../src/pairing/pairing-store.js";
import { createPluginRuntime } from "../../../../src/plugins/runtime/index.js";
import { runOpenClawStateWriteTransaction } from "../../../../src/state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../../../src/test-utils/database-cleanup.js";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  registerSlashCommandRoute,
} from "./slash-state.js";

it("proves pairing capacity through the registered Mattermost slash HTTP route", async () => {
  const phase = process.env.MATTERMOST_PROOF_PHASE;
  assert(phase === "baseline" || phase === "fixed", "explicit proof phase required");
  const output = process.env.PROOF_OUTPUT_DIR;
  assert(output && path.isAbsolute(output), "absolute proof output directory required");
  const accountId = "proof-account";
  const errors: string[] = [];
  const responses: Array<{ user: string; status: number; text: string }> = [];
  const restCalls: string[] = [];
  let dispatchCalls = 0;
  let completed = false;
  let cleanedUp = false;

  try {
    await withTempDir("mattermost-slash-pairing-proof-", async (root) => {
      vi.stubEnv("HOME", root);
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      await fs.writeFile(path.join(root, "openclaw.json"), "{}");
      runOpenClawStateWriteTransaction(() => undefined);
      const runtime = createPluginRuntime();
      // Safety fuse only: authorization, store, formatter, and HTTP handling remain real.
      runtime.channel.inbound.dispatch = async () => {
        dispatchCalls += 1;
        throw new Error("A pairing-denied command reached agent dispatch");
      };
      setMattermostRuntime(runtime);
      const routeRuns = new Set<Promise<void>>();
      let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
      let command: MattermostRegisteredCommand;

      try {
        await withServer((req, res) => {
          if (req.url === "/mattermost/slash") {
            assert(handler, "slash route must be registered before requests");
            const run = handler(req, res)
              .catch((error: unknown) => {
                errors.push(String(error));
                res.statusCode = 500;
                res.end("Fixture handler failure");
              })
              .finally(() => routeRuns.delete(run));
            routeRuns.add(run);
            return;
          }
          restCalls.push(`${req.method} ${req.url}`);
          if (req.headers.authorization !== "Bearer proof-bot-token") {
            errors.push("Unexpected fixture REST authorization");
            res.statusCode = 401;
            res.end("Unauthorized fixture REST request");
            return;
          }
          res.setHeader("content-type", "application/json");
          if (req.method === "GET" && req.url === "/api/v4/commands/proof-command") {
            res.end(JSON.stringify({
              id: command.id, team_id: command.teamId, trigger: command.trigger,
              method: "P", url: command.url, token: command.token, delete_at: 0,
            }));
          } else if (req.method === "GET" && req.url === "/api/v4/channels/proof-dm") {
            res.end(JSON.stringify({ id: "proof-dm", name: "proof-dm", type: "D" }));
          } else {
            errors.push(`Unexpected fixture request: ${req.method} ${req.url}`);
            res.statusCode = 404;
            res.end("{}");
          }
        }, async (baseUrl) => {
          const account: ResolvedMattermostAccount = {
            accountId, enabled: true, botToken: "proof-bot-token", botTokenSource: "config",
            baseUrl, baseUrlSource: "config", streamingMode: "partial",
            config: { dmPolicy: "pairing", network: { dangerouslyAllowPrivateNetwork: true } },
          };
          const cfg = {
            commands: { text: true },
            channels: { mattermost: { accounts: { [accountId]: {
              ...account.config, botToken: account.botToken, baseUrl,
              commands: { native: true, callbackPath: "/mattermost/slash" },
            } } } },
          };
          // The registration fixture supplies only API fields this production registrar consumes.
          registerSlashCommandRoute({
            config: cfg,
            logger: { warn: (message: string) => errors.push(message) },
            registerHttpRoute: (route: {
              path: string; auth?: string;
              handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
            }) => {
              expect(route.path).toBe("/mattermost/slash");
              expect(route.auth).toBe("plugin");
              assert(!handler, "one slash callback route expected");
              handler = route.handler;
            },
          } as Parameters<typeof registerSlashCommandRoute>[0]);
          assert(handler, "production route registration required");
          command = {
            id: "proof-command", teamId: "proof-team", trigger: "oc_status",
            token: "proof-command-token", url: `${baseUrl}/mattermost/slash`, managed: false,
          };
          activateSlashCommands({
            account, commandTokens: [command.token], registeredCommands: [command],
            api: { cfg, runtime: {
              log() {}, error: (...args: unknown[]) => errors.push(args.join(" ")), exit() {},
            } },
          });
          const post = async (user: string) => {
            const response = await fetch(command.url, {
              method: "POST", signal: AbortSignal.timeout(15_000),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Token ${command.token}`,
              },
              body: new URLSearchParams({
                token: command.token, team_id: command.teamId, channel_id: "proof-dm",
                user_id: user, user_name: user, command: "/oc_status", text: "",
              }),
            });
            const payload = await response.json();
            await Promise.all(routeRuns);
            expect(response.status).toBe(200);
            expect(payload.response_type).toBe("ephemeral");
            expect(typeof payload.text).toBe("string");
            responses.push({ user, status: response.status, text: payload.text });
            return payload.text as string;
          };
          for (const user of ["user-1", "user-2", "user-3"]) {
            const text = await post(user);
            const requests = await listChannelPairingRequests("mattermost", process.env, accountId);
            const stored = requests.find((request) => request.id === user);
            assert(stored, "callback must persist its request in the real account store");
            expect(stored.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u);
            expect(text).toContain(`Pairing code:\n\`\`\`\n${stored.code}\n\`\`\``);
            expect(text).toContain(`pairing approve mattermost ${stored.code}`);
          }
          const before = await listChannelPairingRequests("mattermost", process.env, accountId);
          expect(before.map((request) => request.id).sort()).toEqual(["user-1", "user-2", "user-3"]);
          const denied = await post("user-4");
          if (phase === "baseline") {
            expect(denied).toContain("Pairing code:\n```\n\n```");
            expect(denied).toContain("pairing approve mattermost");
          } else {
            expect(denied).toBe("Unauthorized.");
          }
          const after = await listChannelPairingRequests("mattermost", process.env, accountId);
          expect(after.map(({ id, code }) => ({ id, code }))).toEqual(before.map(({ id, code }) => ({ id, code })));
          const first = before.find((request) => request.id === "user-1");
          assert(first);
          expect(await post("user-1")).toContain(`pairing approve mattermost ${first.code}`);
          expect(await runtime.channel.pairing.readAllowFromStore({ channel: "mattermost", accountId })).toEqual([]);
          expect(await listChannelPairingRequests("mattermost", process.env, "other-account")).toEqual([]);
          expect(dispatchCalls).toBe(0);
          expect(restCalls.filter((call) => call === "GET /api/v4/commands/proof-command")).toHaveLength(5);
          expect(restCalls.filter((call) => call === "GET /api/v4/channels/proof-dm")).toHaveLength(5);
          expect(errors).toEqual([]);
          completed = true;
        });
      } finally {
        deactivateSlashCommands(accountId);
        await Promise.all(routeRuns);
        await closeStateDatabaseForTest();
        vi.unstubAllEnvs();
      }
    });
    cleanedUp = true;
  } finally {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, `mattermost-${phase}.json`), JSON.stringify({
      phase, completed, cleanedUp, productBehaviorPassed: completed && phase === "fixed",
      baselineBugObserved: completed && phase === "baseline", dispatchCalls, restCalls, errors,
      responses: responses.map((response) => ({
        ...response, text: response.text.replace(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}/gu, "<fixture-code>"),
      })),
    }, null, 2));
  }
}, 30_000);
