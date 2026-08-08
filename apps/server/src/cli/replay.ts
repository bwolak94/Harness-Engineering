/**
 * harness:replay — replay a workflow's event log to a specific sequence number.
 *
 * Usage: pnpm harness:replay <workflowId> [--to-seq=N]
 *
 * Loads all events for the workflow from the event log, replays them through
 * the reducer up to (and including) seq N, and prints the resulting state.
 * If --to-seq is omitted, replays all events (shows current state from events).
 *
 * Useful for debugging: inspect what the agent state looked like at any point
 * in history without modifying any stored data.
 *
 * Exit codes:
 *   0 — success; state printed to stdout as JSON
 *   1 — workflow not found or bad arguments
 */
import { parseEnv } from "@harness/contracts/env";
import { initialWorkflowState, reduce } from "@harness/core";
import { compose } from "../composition/compose.js";

const args = process.argv.slice(2);
const workflowId = args[0];

if (!workflowId) {
  console.error("Usage: harness:replay <workflowId> [--to-seq=N]");
  process.exit(1);
}

// Parse optional --to-seq=N flag
let toSeq = Number.POSITIVE_INFINITY;
for (const arg of args.slice(1)) {
  const match = arg.match(/^--to-seq=(\d+)$/);
  if (match?.[1] !== undefined) {
    toSeq = Number.parseInt(match[1], 10);
  }
}

const env = parseEnv();
const { service } = compose(env);

const events = await service.getEvents(workflowId);
if (events.length === 0) {
  console.error(`[harness:replay] No events found for workflow '${workflowId}'`);
  process.exit(1);
}

// Replay events up to toSeq through the pure reducer
const replayedEvents =
  toSeq === Number.POSITIVE_INFINITY ? events : events.filter((e) => e.seq <= toSeq);

let state = initialWorkflowState(workflowId);
for (const event of replayedEvents) {
  state = reduce(state, event);
}

const label =
  toSeq === Number.POSITIVE_INFINITY
    ? `(all ${events.length} events)`
    : `(up to seq ${toSeq}, ${replayedEvents.length} events replayed)`;

console.log(`[harness:replay] Workflow ${workflowId} state ${label}:`);
console.log(JSON.stringify(state, null, 2));
process.exit(0);
