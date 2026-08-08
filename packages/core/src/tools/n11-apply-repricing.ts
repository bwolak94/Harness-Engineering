import type { ToolDefinition } from "@harness/contracts";
import {
  type ApplyRepricingInput,
  ApplyRepricingInputSchema,
  type ApplyRepricingOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";
import type { IdempotencyStorePort } from "../ports/idempotency-store.port.js";
import type { OutboxItem, OutboxPort } from "../ports/outbox.port.js";

/**
 * N11 — applyRepricing
 *
 * The first irreversible action in the project. Publishes approved price changes
 * to the catalogue via the Transactional Outbox pattern:
 *
 *   1. Check idempotency store — if this idempotencyKey was already processed,
 *      return the cached "skipped: duplicate" result without side effects.
 *   2. Enqueue an outbox item for the catalogue API call.
 *      Enqueueing is idempotent by idempotencyKey — safe to call multiple times.
 *   3. Return the list of changes that were enqueued (status: pending delivery).
 *
 * The actual HTTP call to the catalogue happens in a separate outbox worker
 * (at-least-once delivery). The catalogue API uses the same idempotencyKey for
 * deduplication on its side, converting at-least-once into effectively-once.
 *
 * Crash safety:
 *   - Crash before enqueue: on resume, idempotency store has no entry → tool
 *     re-executes → enqueues again → duplicate-safe because outbox deduplicates.
 *   - Crash after enqueue but before tool.succeeded: the event log shows
 *     tool.called without tool.succeeded → resume re-runs → idempotency store
 *     returns cached result → no double enqueue.
 */
export interface ApplyRepricingDeps {
  outbox: OutboxPort;
  idempotencyStore: IdempotencyStorePort;
  /** Current prices in the catalogue, keyed by SKU. Used to record previousPrice. */
  catalogue: Map<string, number>;
  clock: { nowIso(): string; newId(): string };
}

export function createApplyRepricingTool(
  definition: ToolDefinition,
  deps: ApplyRepricingDeps,
): Tool<ApplyRepricingInput, ApplyRepricingOutput> {
  return {
    definition,
    inputSchema: ApplyRepricingInputSchema,

    async execute(input) {
      const { outbox, idempotencyStore, catalogue, clock } = deps;

      // --- Idempotency check: return cached result if already processed ---
      const cached = await idempotencyStore.get(input.idempotencyKey);
      if (cached !== undefined) {
        const cachedOutput = cached as ApplyRepricingOutput;
        // Mark all applied items as "duplicate" skips in the re-run response
        return {
          applied: [],
          skipped: [
            ...cachedOutput.applied.map((a) => ({
              sku: a.sku,
              reason: "duplicate" as const,
              detail: `Already applied at ${a.appliedAt}`,
            })),
            ...cachedOutput.skipped,
          ],
        };
      }

      const applied: ApplyRepricingOutput["applied"] = [];
      const skipped: ApplyRepricingOutput["skipped"] = [];

      for (const change of input.changes) {
        const previousPrice = catalogue.get(change.sku);
        if (previousPrice === undefined) {
          skipped.push({
            sku: change.sku,
            reason: "rejected",
            detail: `SKU '${change.sku}' not found in catalogue`,
          });
          continue;
        }

        applied.push({
          sku: change.sku,
          previousPrice,
          newPrice: change.newPrice,
          appliedAt: input.effectiveAt,
        });

        // Update the in-memory catalogue (represents the local write in a real system)
        catalogue.set(change.sku, change.newPrice);
      }

      // --- Enqueue outbox item for the external API call ---
      // The outbox worker will deliver this with at-least-once semantics.
      // The idempotencyKey ensures the catalogue API deduplicates retries.
      const outboxItem: OutboxItem = {
        id: clock.newId(),
        action: "catalogue.applyRepricing",
        payload: {
          changes: applied.map((a) => ({ sku: a.sku, newPrice: a.newPrice })),
          effectiveAt: input.effectiveAt,
        },
        idempotencyKey: input.idempotencyKey,
        enqueuedAt: clock.nowIso(),
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
      };
      await outbox.enqueue(outboxItem);

      const result: ApplyRepricingOutput = { applied, skipped };

      // --- Cache result for idempotent re-runs ---
      // Stored AFTER enqueueing so a crash between execute and here still
      // re-enqueues on the next attempt (outbox deduplication handles that).
      await idempotencyStore.set(input.idempotencyKey, result);

      return result;
    },
  };
}
