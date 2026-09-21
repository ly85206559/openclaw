import { expectDefined } from "@openclaw/normalization-core";
import { createTaskFlowForTask } from "../../src/tasks/task-flow-registry.js";
import { recordTaskActivityEvent } from "../../src/tasks/task-registry-activity.js";
import { updateTask } from "../../src/tasks/task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "../../src/tasks/task-registry-publication.js";
import {
  getTaskById,
  listTasksForFlowId,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
} from "../../src/tasks/task-registry-query.js";
import { createTaskRecord, linkTaskToFlowById } from "../../src/tasks/task-registry-record-api.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../../src/tasks/task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../../src/tasks/task-registry.store.sqlite.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../src/tasks/task-runtime.test-helpers.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

function createTask(params: Partial<Parameters<typeof createTaskRecord>[0]> = {}) {
  return expectDefined(
    createTaskRecord({
      runtime: "cli",
      scopeKind: "session",
      ownerKey: "agent:main:owner",
      requesterSessionKey: "agent:main:requester",
      childSessionKey: "agent:main:child",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      task: "Runtime task-index proof",
      ...params,
    }),
    "created task",
  );
}

function assertIds(label: string, actual: string[], expected: string[]) {
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${label}: expected ${expected.join(",")}; received ${actual.join(",")}`);
  }
}

const state = await createOpenClawTestState({ scenario: "minimal" });
resetTaskRegistryForTests({ persist: false });
resetTaskFlowRegistryForTests({ persist: false });
try {
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  let first: ReturnType<typeof createTask>;
  let second: ReturnType<typeof createTask>;
  try {
    first = createTask();
    const flow = expectDefined(createTaskFlowForTask({ task: first }), "created flow");
    first = expectDefined(
      linkTaskToFlowById({ taskId: first.taskId, flowId: flow.flowId }),
      "first linked task",
    );
    second = createTask();
    second = expectDefined(
      linkTaskToFlowById({ taskId: second.taskId, flowId: flow.flowId }),
      "second linked task",
    );
  } finally {
    Date.now = realNow;
  }
  const memberships = () => ({
    owner: listTasksForOwnerKey(first.ownerKey).map((task) => task.taskId),
    related: listTasksForRelatedSessionKey(first.requesterSessionKey).map((task) => task.taskId),
    flow: listTasksForFlowId(first.parentFlowId!).map((task) => task.taskId),
  });
  const before = memberships();
  const stableOrder = [second.taskId, first.taskId];
  for (const [name, ids] of Object.entries(before)) {
    assertIds(`before ${name}`, ids, stableOrder);
  }
  expectDefined(updateTask(first.taskId, { progressSummary: "native metadata" }), "native update");
  const afterNative = memberships();
  for (const [name, ids] of Object.entries(afterNative)) {
    assertIds(`after native ${name}`, ids, stableOrder);
  }
  const atomic = { ...first, progressSummary: "atomic metadata" };
  upsertTaskWithDeliveryStateToSqlite({ task: atomic });
  publishTaskRecordAfterAtomicStore(atomic);
  const afterAtomic = memberships();
  const atomicOrder = [first.taskId, second.taskId];
  for (const [name, ids] of Object.entries(afterAtomic)) {
    assertIds(`after atomic ${name}`, ids, atomicOrder);
  }

  const created = createTask({ runId: "run-before-flush" });
  const flow = expectDefined(createTaskFlowForTask({ task: created }), "created reentrant flow");
  const task = expectDefined(
    linkTaskToFlowById({ taskId: created.taskId, flowId: flow.flowId }),
    "linked reentrant task",
  );
  recordTaskActivityEvent(task, {
    runId: task.runId!,
    seq: 1,
    stream: "assistant",
    ts: Date.now(),
    data: { text: "Synthetic pending activity" },
  });
  let reentered = false;
  configureTaskRegistryRuntime({
    observers: {
      onEvent(event) {
        if (!reentered && event.kind === "upserted" && event.task.taskId === task.taskId) {
          reentered = true;
          updateTask(task.taskId, {
            ownerKey: "agent:main:stale-owner",
            requesterSessionKey: "agent:main:stale-requester",
            childSessionKey: "agent:main:stale-child",
            parentFlowId: undefined,
          });
        }
      },
    },
  });
  expectDefined(
    updateTask(task.taskId, { status: "succeeded", endedAt: Date.now() }),
    "completion",
  );
  const reentrant = {
    observerRan: reentered,
    staleOwnerCount: listTasksForOwnerKey("agent:main:stale-owner").length,
    staleRequesterCount: listTasksForRelatedSessionKey("agent:main:stale-requester").length,
    restoredOwnerIds: listTasksForOwnerKey(task.ownerKey).map((row) => row.taskId),
    restoredFlowIds: listTasksForFlowId(task.parentFlowId!).map((row) => row.taskId),
    status: getTaskById(task.taskId)?.status,
  };
  if (
    !reentrant.observerRan ||
    reentrant.staleOwnerCount !== 0 ||
    reentrant.staleRequesterCount !== 0 ||
    reentrant.status !== "succeeded"
  ) {
    throw new Error(`reentrant publication proof failed: ${JSON.stringify(reentrant)}`);
  }
  assertIds("restored owner", reentrant.restoredOwnerIds, [task.taskId]);
  assertIds("restored flow", reentrant.restoredFlowIds, [task.taskId]);

  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        storage: "isolated SQLite task registry",
        equalTimeMembershipOrder: { before, afterNative, afterAtomic },
        reentrantPublication: reentrant,
      },
      null,
      2,
    ),
  );
} finally {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await state.cleanup();
}
