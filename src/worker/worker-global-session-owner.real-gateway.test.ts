import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  ComposedGatewayHarness,
  type WorkerClients,
} from "./worker-fault-injection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function transcriptMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  };
}

async function stopClients(clients: WorkerClients | undefined): Promise<void> {
  if (!clients) {
    return;
  }
  clients.inference.dispose();
  clients.live.dispose();
  await clients.connection.stop();
}

describe("PR 139216 real Gateway worker proof", () => {
  it("attaches and persists a non-default agent's global session", async () => {
    const expected = process.env.OPENCLAW_PR_139216_EXPECT ?? "after-fix";
    const harness = await ComposedGatewayHarness.create(tempDirs.make("oc-pr-139216-"), {
      agentId: "work",
      sessionKey: "global",
      sessionScope: "global",
    });
    let clients: WorkerClients | undefined;

    try {
      await harness.start();
      clients = harness.createClients();
      await clients.connection.start();

      const commit = clients.transcript.commit([
        transcriptMessage("Persist through the connected worker"),
      ]);
      if (expected === "before-fix") {
        const error: unknown = await commit.then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(error).toMatchObject({
          name: "WorkerTranscriptCommitError",
          reason: "session-not-attached",
        });
        expect(SessionManager.open(harness.sessionTarget).getEntries()).toEqual([]);
        console.log(
          JSON.stringify({
            proof: "pr-139216-worker-global-owner",
            revision: "before-fix",
            workerConnection: clients.connection.state.kind,
            transcriptCommit: "session-not-attached",
            persistedEntries: 0,
          }),
        );
        return;
      }

      const result = await commit;
      const entries = SessionManager.open(harness.sessionTarget).getEntries();
      expect(harness.admissions).toHaveLength(1);
      expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
      expect(entries).toEqual([
        expect.objectContaining({
          id: result.newLeafId,
          message: expect.objectContaining({ role: "user" }),
        }),
      ]);
      console.log(
        JSON.stringify({
          proof: "pr-139216-worker-global-owner",
          revision: "after-fix",
          admittedWorkers: harness.admissions.length,
          transcriptCommitFrames: harness.requestParams("worker.transcript.commit").length,
          transcriptCommit: "accepted",
          persistedAgent: "work",
          persistedSessionKey: "global",
          persistedEntries: entries.length,
        }),
      );
    } finally {
      await stopClients(clients);
      await harness.close();
    }
  });
});
