// Temporary observation overlay, never a proposed product change.
import { writeSync } from "node:fs";

type Snapshot = {
  ownerPhase: string;
  closed: boolean;
  aborted: boolean;
  deadlineDeltaMs: number | null;
};
type Detail = {
  code?: string;
  replacing?: boolean;
  renewalPresent?: boolean;
  transaction?: boolean;
};
type Event = Detail &
  Partial<Snapshot> & {
    event: string;
    lease: number;
    elapsedUs: number;
    childPhase: string;
  };
type Capture = {
  role: string;
  start: bigint;
  nextLease: number;
  phase: string;
  events: Event[];
  firstAborts: Event[];
  dropped: number;
  flushed: boolean;
};
let active: Capture | undefined;
const MAX_EVENTS = 256;
const MAX_FIRST_ABORTS = 32;

export function beginObservation(role: string): void {
  if (active || (role !== "alpha" && role !== "beta")) {
    throw new Error("Invalid proof observation initialization");
  }
  active = {
    role,
    start: process.hrtime.bigint(),
    nextLease: 0,
    phase: "setup",
    events: [],
    firstAborts: [],
    dropped: 0,
    flushed: false,
  };
}

function record(capture: Capture, data: Omit<Event, "elapsedUs" | "childPhase">): void {
  const event = {
    ...data,
    elapsedUs: Number((process.hrtime.bigint() - capture.start) / 1_000n),
    childPhase: capture.phase,
  };
  if (data.event === "first-abort") {
    if (capture.firstAborts.length < MAX_FIRST_ABORTS) capture.firstAborts.push(event);
    else capture.dropped++;
  }
  if (capture.events.length < MAX_EVENTS) capture.events.push(event);
  else capture.dropped++;
}

export function setObservationPhase(phase: string): void {
  if (!active) return;
  active.phase = phase;
  record(active, { event: "child-phase", lease: 0 });
}

export function createLeaseObservation(
  snapshot: () => Snapshot,
): ((event: string, detail?: Detail) => void) | undefined {
  const capture = active;
  if (!capture) return undefined;
  const lease = ++capture.nextLease;
  return (event, detail = {}) => record(capture, { event, lease, ...snapshot(), ...detail });
}

export function observationErrorCode(error: unknown): string {
  if (error === undefined) return "NONE";
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    // No arbitrary error text, identifiers, paths, tokens, or unbounded codes leave the child.
    return typeof code === "string" &&
      [
        "OPENCLAW_STATE_LEASE_LOST",
        "OPENCLAW_STATE_LEASE_ABORTED",
        "SQLITE_BUSY",
        "SQLITE_LOCKED",
        "ERR_SQLITE_ERROR",
      ].includes(code)
      ? code
      : "OTHER";
  } catch {
    return "OTHER";
  }
}

export function flushObservation(): void {
  const capture = active;
  if (!capture || capture.flushed) return;
  capture.flushed = true;
  // Exactly one output at the end of this synthetic child, outside the observed hot path.
  try {
    writeSync(
      2,
      "LEASE_OBS:" +
        JSON.stringify({
          version: 1,
          role: capture.role,
          events: capture.events,
          firstAborts: capture.firstAborts,
          dropped: capture.dropped,
        }) +
        "\n",
    );
  } catch {
    // Diagnostic output must not replace the operation's original exception.
    // The controller rejects missing observations; no output retry or repair.
  }
}
