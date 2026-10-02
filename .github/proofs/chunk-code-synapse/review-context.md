# Supplemental proof review context

These fork-only assets supplement PR #163697 at exact product head
2725b3b8951af667b1367b1785efc2f721202790. Existing immutable run 37041362693
supplies 116 passing focused checks, formatting/lint, core production types and
all src test type shards. Upstream CI 37044850457 and both required contexts also
passed. Product P3 review is clean. The remaining gate is the previously mocked
final Matrix sender; this proof must use the actual normal sender and server.

Compare untouched upstream 32e30e59d9a7fd1f5b3a9e9659427d45145779dd against
exact product head, never overlay production, and run only in secretless fork
Actions. No local source execution, broker/Testbox, paid cloud, operator
credentials, production configuration or Gateway state is authorized. Synthetic
accounts are issued by this job's real loopback-only Synapse. This is actual
client/server delivery against a task-owned isolated homeserver, not Telegram,
public Matrix, encryption, audio or durable queue custody proof.

Owner contracts personally checked in source:

- `loadAndActivateRootPluginRegistry` activates normal plugin loading; its
  options support config, onlyPluginIds, cache, preferBuiltPluginArtifacts and
  throwOnLoadError.
- Matrix's bundled entry loads `matrixPlugin` from its public channel artifact
  and `setMatrixRuntime` from its runtime setter using the same loader context.
- Bare plugin runtime state stores throw. Real registry-scoped runtime grants
  normal bundled/official records actual SQLite stores. Do not replace the
  store, fabricate a trusted record or separately install a plugin runtime.
- Matrix outbound falls back to real `sendMessageMatrix` when no deps.matrix
  override is supplied. Normal bootstrap obtains a transient lease, starts the
  actual Matrix SDK and release quiesces/stops/persists it. The existing private
  network option and encryption:false are this loopback fixture's settings,
  not new product configuration or policy.
- `renderMatrixBody` preserves original projected Markdown without spoiler or
  metadata collisions; this fixture has neither. Assert full fenced Markdown
  body and actual markdown-it formatted HTML, not recomputed expected bytes.
- Shared Vitest setup installs a stub registry beforeAll and afterEach. Load
  the real Matrix registry inside each row, cache:false, then retire it normally.
  Shared setup mocks unrelated OAuth/clipboard, not Matrix/HTTP/storage. Claim
  no Matrix/sender/store mocks, not zero framework mocks.

Official Synapse v1.162.0 identity from Docker Hub is manifest
sha256:6b84a7bbac36f080b2d2e51e0289cf1b08b349598ea44a558df38d558f2c2311,
Linux amd64 child43fd704aedef503a6fba2e5696439ef7bac24479a3472e364561973f550e4aad.
Its Docker README documents generate and multiple config paths. `docker/start.py`
241-243 preserves run arguments and adds only -m when absent; 252-277 leaves
explicit config paths intact; 279-287 executes all arguments. Keep generated
base config and reviewed fixture overrides. Only this job's run-ID/phase named
container and volume may be removed in always cleanup. Matrix v1.17 GET room
event's ClientEvent requires room_id; retain that strong read-back assertion.

Proof guards: four fixed U+2028/U+2029 by length/newline rows. RED permits exactly
two newline failures only at remote body JSON parsing; length controls pass.
GREEN requires all four pass. Generic SyntaxError matching was rejected because
HTTP response parsing can throw the same error. Only the final body parse emits
`SYNAPSE_REMOTE_JSON_REGRESSION:<phase>:<label>:<mode>`. Require exact two RED
markers, four unique completed read-back traces with matching phase/source/modes
and expected JSON validity, plus cleanup-complete emitted after both accounts
log out. Setup/network/receipt/auth/cleanup errors cannot count as expected RED.
Mask generated passwords, tokens and user/device identities before diagnostics;
do not log arbitrary credential-bearing configs or raw server logs.

P3 v1 identified omitted global/suite errors and incomplete HTML content checks.
The supplemental Vitest 5.0.1 reporter records onTestRunEnd's unhandled errors,
recursive suite error counts and termination reason; the wrapper rejects any
additional error, hook error or extra failure entry. Its official JSON reporter
omits those errors. The remote formatted_body now must equal the complete fenced
JSON HTML (quote-escaped remote code and one fence trailing LF); format.ts uses
the standard markdown-it fence renderer then trimEnd. The exact original body
assertion ensures GREEN HTML retains the original Unicode bytes, not merely a
matching opening tag. No production formatter helper computes expected output.

P3 v2 found selected reporters can omit intercepted console output. The error
reporter now forwards onUserConsoleLog's literal content to stdout, preserving
the exact read-back, cleanup and add-mask records rather than depending on
default reporters. The wrapper prints captured stdout (including masks) before
stderr or summarized test failure diagnostics. This matches the official
Vitest 5.0.1 onUserConsoleLog dispatch contract.

First hosted run 37049708084 correctly failed both phases before any send:
shared-state admission requires isMainThread, but generic project routing chose
a thread worker for this new proof file. This is not a product RED. The proof now
uses the repository's existing infra config (it already specifies pool:forks)
and explicit --pool=forks, and beforeAll asserts a real Node host main thread.
Normal shared-state ownership, native SQLite workers, grants and cleanup remain
unchanged. Do not add a fake broker/store or disable state admission. This local
OpenClaw SQLite owner is unrelated to the forbidden external crabbox broker.

Second hosted run 37051011888 failed before any test because package test directly
uses test-projects, which injects its planned unit-fast --config and retained the
explicit infra --config. Vitest correctly rejects duplicate scalar options. The
runner now uses supported node scripts/run-vitest.mjs run --config=infra instead;
its existing explicit-config guard skips project delegation while retaining
normal runtime preparation/watchdog/cleanup. --pool=forks and every row assertion
remain unchanged. afterAll also awaits the actual existing shared-state owner's
closeOpenClawStateDatabaseAsync, aggregates that failure with logout failures and
emits cleanup-complete only after retirement. Only isolated job-owned state exists
in this test process; no external host/member broker or live operator state.
