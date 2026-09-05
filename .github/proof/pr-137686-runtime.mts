import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const source = "740466fe464205ba83154c45e631db7a8b65740c";
assert.equal(execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim(), source);
const diff = execFileSync("git", ["diff", "--name-only", source, "HEAD"], { encoding: "utf8" }).trim().split("\n");
assert.deepEqual(diff.sort(), [".github/proof/pr-137686-runtime.mts", ".github/workflows/pr-137686-runtime.yml"]);
process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "account-label-proof-"));
const { resolveChatAccountSelection } = await import("../../src/gateway/server-methods/chat-account-selection.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { connectUserModelAccount, listUserModelAccounts, readUserModelAuthProfile } = await import("../../src/state/user-model-accounts.js");
const { closeOpenClawStateDatabaseByPath } = await import("../../src/state/openclaw-state-db.js");

console.log(JSON.stringify({ source, node: process.version, platform: process.platform, mocks: false, networkProviderCalls: false }));
const prefix = "x".repeat(255);
for (const [scenario, input, expected] of [
  ["emoji-boundary", prefix + "\u{1f916}", prefix],
  ["persisted-lone-high-surrogate", prefix + "\ud83e", prefix + "\ufffd"],
] as const) {
  const credential = { type: "token" as const, provider: "anthropic", token: "synthetic-proof-only", displayName: input };
  const sharedStore = { version: 1, profiles: { shared: credential } };
  const originalStore = JSON.stringify(sharedStore);
  const shared = resolveChatAccountSelection({ authStore: sharedStore, sessionEntry: { authProfileOverride: "shared" } });
  assert.equal(shared.label, expected);
  assert.equal(JSON.stringify(sharedStore), originalStore);
  console.log(JSON.stringify({ path: "shared-chat/resolveChatAccountSelection", scenario, inputLength: input.length, inputLastUnit: input.charCodeAt(input.length - 1).toString(16), labelLength: shared.label.length, labelLastUnit: shared.label.charCodeAt(shared.label.length - 1).toString(16), labelWellFormed: shared.label.isWellFormed(), originalCredentialUnchanged: true, kind: shared.kind }));

  const options = { path: join(process.env.OPENCLAW_STATE_DIR, scenario + ".sqlite") };
  const owner = ensureProfileForEmail("proof@example.test", options);
  const { authProfileId } = connectUserModelAccount({ ownerProfileId: owner.id, credential, assertCurrent() {} }, options);
  closeOpenClawStateDatabaseByPath(options.path);
  assert.ok(statSync(options.path).size > 0);
  const before = readUserModelAuthProfile(authProfileId, options)?.credential;
  assert.equal(before?.displayName, input);
  const inventory = listUserModelAccounts({ profileId: owner.id }, options);
  assert.equal(inventory.accounts.length, 1);
  assert.equal(inventory.accounts[0]?.label, expected);
  const after = readUserModelAuthProfile(authProfileId, options)?.credential;
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(inventory).includes("synthetic-proof-only"), false);
  const label = inventory.accounts[0]!.label;
  console.log(JSON.stringify({ path: "personal-inventory/listUserModelAccounts", scenario, realSqliteReopened: true, storedLastUnit: before!.displayName!.charCodeAt(input.length - 1).toString(16), labelLength: label.length, labelLastUnit: label.charCodeAt(label.length - 1).toString(16), labelWellFormed: label.isWellFormed(), storedCredentialUnchanged: true, secretAbsentFromInventory: true, selected: inventory.accounts[0]!.selected }));
  closeOpenClawStateDatabaseByPath(options.path);
}
console.log("PASS: all four production-owner scenarios; no mocks; original credentials preserved");
