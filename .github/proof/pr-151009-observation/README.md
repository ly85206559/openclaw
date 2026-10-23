# PR 151009 single-cell lease observation

These files are a proof-only observation carrier. No root cause, repair, reproducing result, fresh CI pass, or execution is claimed by the source. Do not push until the source context and complete exact-head P0–P3 review have been checked.

## Files and proposed carrier layout

- `controller.mjs`, `overlay.json`, `observer.proof.ts` → `.github/proof/pr-151009-observation/` in a new isolated proof carrier.
- Workflow: `.github/workflows/proof-151009-observation.yml`.
- Isolated fork-only branch: `codex/proof-pr151009-observe-20261023`.

The workflow has one immutable original-tested-merge cell, no baseline rerun, repaired-source cell or retry. It preserves original six ordered groups and runner environment from proof `e8b840e774afc1ec8aa04902265180b7ecd08849`. Execution is limited to a push of this exact fork-only branch after complete review; the runner records the immutable pushed carrier SHA. A branch/ref match establishes identity, not evidence that review occurred.

## Unknown and observation boundary

Determine where first abort occurred (release-marker wait, async records read, later write/assert), whether native expiry fired before its selected Date deadline, and whether renewal failed to run or hit an existing swallowed error. Original delay, heartbeat, SQL, waits, thresholds, assertions, transaction/cleanup and exception policies remain unchanged. This is source instrumentation, not literally unchanged source; receipts record original and after-overlay identities.

Only named synthetic alpha/beta children start the recorder; other leases return no observer. Fields are hrtime relative microseconds, selected-clock deadline deltas, phases, booleans and allowlisted error codes. No owner IDs/tokens/keys, private paths/config, SQL contents, arbitrary error messages/codes are emitted. Events cap at 256; first-abort records separately cap at 32; overflow explicit. Child finally flushes once after its operation; parent forwards only sanitized `LEASE_OBS:` lines including on success. SIGKILL can produce a missing child observation; that is not proof.

## Minimal original context the lead must inspect

At `4be713527fbc5f6eb815294cd525f934404516a0`:

- `src/state/openclaw-state-lease.ts`: abortLost/assertActive 140–159; revoke/finish 225–262; scheduleExpiry/renewFromTimer/assertOperationOwned 336–386; native owner 515–570; exception propagation/prepareCleanup 573–623.
- `src/state/openclaw-state-lease-cleanup.ts`: whole file, preserves operation failure across prepareCleanup/finish and resolves operation-settled barrier.
- `src/state/openclaw-state-lease-process-exit.ts`: whole file, synchronous best-effort release/stderr routing, unmodified.
- `src/plugins/plugin-lifecycle-lease.test.ts`: parent runLeaseChild close/output 79–159; named cache-handoff case 432–559; frozen Date preload and performance override retained.
- `src/plugins/plugin-lifecycle-lease.ts`: whole wrapper, retained cache cleanup and rethrow.
- `src/plugins/installed-plugin-index-store-write.ts`: transaction 204–249 and assertOwnedInTransaction, unmodified.
- `src/state/openclaw-state-lease-storage.ts`: native renew/verify contracts, unmodified.

## Gates and future secretless-runner commands

Controller refuses local execution. Before writing: validate immutable source/tree, four pinned blobs, original group bytes/hash/order and every single-occurrence text anchor. Any mismatch fails; no fallback. All checks finish before source writes. Afterward verify exact overlay identities, unchanged cleanup/process-exit files, tracked change set and only the new helper untracked. Review overlay.json literally: it contains every source transformation.

With reviewed carrier in `instructions` and original source in `source`:

```bash
node instructions/.github/proof/pr-151009-observation/controller.mjs apply "$GITHUB_WORKSPACE/source" "$RUNNER_TEMP/lease-observation"
# In source, with exact env from proof-151009-observation.yml:
node --import tsx scripts/ci-run-node-test-shard.mts
node instructions/.github/proof/pr-151009-observation/controller.mjs collect "$GITHUB_WORKSPACE/source" "$RUNNER_TEMP/lease-observation"
node instructions/.github/proof/pr-151009-observation/controller.mjs verify "$GITHUB_WORKSPACE/source" "$RUNNER_TEMP/lease-observation"
```

Workflow owns raw log/exit capture. Six-group completion, sanitized child data, overflow/completeness and overlay identity are separate receipts. A diagnostic job may retain ordinary test failure; inspect original.exit and observation-receipt.json. PASS is NON_REPRODUCING_NOT_A_REPAIR, never an original required-CI pass. Missing child/overflow is partial. No unchanged repeat.

## Preparation validation and limits

Immutable source text-anchor counts, source identities, group bytes/order, and observation boundaries were checked statically, including an independent P0–P3 source review. This is not the required committed exact-head autoreview or a runtime result. The controller and product tests run only in the secretless runner after the publication gate. No paid providers, live services, extra SQL/timers/sleeps/IPC, or new runtime authority are introduced.
