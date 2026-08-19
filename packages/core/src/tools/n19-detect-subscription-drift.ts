import type { ToolDefinition } from "@harness/contracts";
import type {
  DetectSubscriptionDriftInput,
  DetectSubscriptionDriftOutput,
  DetectedSubscription,
  DriftAlertSchema,
} from "@harness/contracts/tools";
import { DetectSubscriptionDriftInputSchema } from "@harness/contracts/tools";
import type { z } from "zod";
import type { Tool } from "../application/tool.js";

type DriftAlert = z.infer<typeof DriftAlertSchema>;

// ---------------------------------------------------------------------------
// Merchant name normalisation
// ---------------------------------------------------------------------------

/** Strip common payment-processor prefixes and normalise to a fingerprint. */
function normaliseMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/^(pos\*|sq\*|squ\*|autopay\*|ach\*|bill pay\*|recurring\*|pmt\*|pymt\*)\s*/i, "")
    .replace(/\*[a-z0-9]+$/i, "") // trailing auth codes
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40); // cap at 40 chars to avoid over-splitting similar names
}

/** Two merchant names are considered the same subscription if one is a prefix of the other
 *  (after normalisation) or they share ≥ 8 consecutive characters. */
function merchantsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const long = a.length >= b.length ? a : b;
  const short = a.length < b.length ? a : b;
  if (short.length < 4) return a === b;
  return long.startsWith(short) || (short.length >= 8 && long.includes(short));
}

// ---------------------------------------------------------------------------
// Frequency detection
// ---------------------------------------------------------------------------

type Frequency = DetectedSubscription["frequency"];

function detectFrequency(dates: string[]): Frequency {
  if (dates.length < 2) return "irregular";

  const ms = dates.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) {
    gaps.push((ms[i]! - ms[i - 1]!) / (1000 * 60 * 60 * 24)); // days
  }
  const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;

  if (medianGap < 10) return "weekly";
  if (medianGap <= 35) return "monthly";
  if (medianGap <= 100) return "quarterly";
  if (medianGap <= 400) return "annual";
  return "irregular";
}

// ---------------------------------------------------------------------------
// Amount tolerance check
// ---------------------------------------------------------------------------

function withinTolerance(a: number, b: number, tolerancePct: number): boolean {
  const mid = (a + b) / 2;
  if (mid === 0) return true;
  return Math.abs(a - b) / mid <= tolerancePct / 100;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDetectSubscriptionDriftTool(
  definition: ToolDefinition,
): Tool<DetectSubscriptionDriftInput, DetectSubscriptionDriftOutput> {
  return {
    definition,
    inputSchema: DetectSubscriptionDriftInputSchema,

    async execute(input) {
      const assumptions: string[] = [
        `Analysing ${input.transactions.length} transaction(s) over ${input.lookbackMonths} month(s).`,
        `Amount tolerance for same-subscription matching: ±${input.amountTolerancePct}%.`,
        "Subscriptions require ≥ 2 charges to be identified as recurring.",
      ];

      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - input.lookbackMonths);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);

      // Filter to lookback window
      const windowTxns = input.transactions.filter((t) => t.date >= cutoffStr);
      assumptions.push(
        `${windowTxns.length} transaction(s) fall within the lookback window (from ${cutoffStr}).`,
      );

      // Group by normalised merchant
      const groups = new Map<string, typeof windowTxns>();

      for (const t of windowTxns) {
        const norm = normaliseMerchant(t.description);

        // Find existing group with matching name
        let matched: string | undefined;
        for (const key of groups.keys()) {
          if (merchantsMatch(key, norm)) {
            matched = key;
            break;
          }
        }

        const groupKey = matched ?? norm;
        const existing = groups.get(groupKey) ?? [];
        existing.push(t);
        groups.set(groupKey, existing);
      }

      const subscriptions: DetectedSubscription[] = [];
      const nonRecurringIds = new Set<string>(windowTxns.map((t) => t.id));

      for (const [name, txns] of groups.entries()) {
        if (txns.length < 2) continue; // not recurring

        // Check that amounts are within tolerance of each other (or form a drift pattern)
        // Sort by date
        const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
        const amounts = sorted.map((t) => t.amount);

        // Verify at least two consecutive pairs are within tolerance (or drifted from first)
        const baseAmount = amounts[0]!;
        const consistentPairs = amounts.filter((a) =>
          withinTolerance(a, baseAmount, Math.max(input.amountTolerancePct, 30)),
        ).length;
        if (consistentPairs < 2) continue; // amounts too varied — not a subscription

        // Mark as recurring
        for (const t of sorted) nonRecurringIds.delete(t.id);

        const frequency = detectFrequency(sorted.map((t) => t.date));

        // Price history (deduplicate consecutive same amounts)
        const priceHistory = sorted.map((t) => ({ date: t.date, amount: t.amount }));

        // Drift calculation
        const firstAmt = amounts[0]!;
        const lastAmt = amounts[amounts.length - 1]!;
        const driftPct =
          amounts.length >= 2 ? round2(((lastAmt - firstAmt) / firstAmt) * 100) : null;

        // Status
        let status: DetectedSubscription["status"];
        if (driftPct === null || Math.abs(driftPct) < 1) {
          status = "stable";
        } else if (driftPct > 0) {
          status = "increased";
        } else {
          status = "decreased";
        }

        // Check potentially cancelled (last charge > 60 days ago for monthly/weekly)
        const lastDateStr = sorted[sorted.length - 1]?.date ?? sorted[0]!.date;
        const lastDate = new Date(lastDateStr);
        const daysSinceLastCharge = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
        const expectedIntervalDays =
          frequency === "weekly"
            ? 7
            : frequency === "monthly"
              ? 31
              : frequency === "quarterly"
                ? 92
                : 366;
        if (daysSinceLastCharge > expectedIntervalDays * 1.5 + 14) {
          status = "potentially_cancelled";
        }

        const totalPaidInPeriod = sorted.reduce((s, t) => s + t.amount, 0);

        subscriptions.push({
          name: name.slice(0, 1).toUpperCase() + name.slice(1),
          frequency,
          firstChargeDate: sorted[0]?.date ?? "",
          lastChargeDate: sorted[sorted.length - 1]?.date ?? "",
          lastChargeAmount: lastAmt,
          priceHistory,
          driftPct,
          status,
          totalPaidInPeriod: round2(totalPaidInPeriod),
          transactionIds: sorted.map((t) => t.id),
        });
      }

      // Sort by total paid descending
      subscriptions.sort((a, b) => b.totalPaidInPeriod - a.totalPaidInPeriod);

      // Estimated monthly/annual totals
      let monthlyTotal = 0;
      for (const sub of subscriptions) {
        const monthly =
          sub.frequency === "weekly"
            ? sub.lastChargeAmount * 4.33
            : sub.frequency === "monthly"
              ? sub.lastChargeAmount
              : sub.frequency === "quarterly"
                ? sub.lastChargeAmount / 3
                : sub.lastChargeAmount / 12;
        monthlyTotal += monthly;
      }
      const annualTotal = monthlyTotal * 12;

      // Drift alerts
      const driftAlerts: DriftAlert[] = [];

      for (const sub of subscriptions) {
        if (sub.status === "increased" && sub.driftPct !== null && sub.driftPct > 5) {
          driftAlerts.push({
            subscriptionName: sub.name,
            alertType: "price_increase",
            detail: `Price rose ${sub.driftPct.toFixed(1)}% from $${sub.priceHistory[0]?.amount.toFixed(2)} to $${sub.lastChargeAmount.toFixed(2)}`,
            suggestedAction: "Review if this subscription still provides value at the new price",
            severity: sub.driftPct > 20 ? "alert" : "warning",
          });
        }

        if (sub.status === "potentially_cancelled") {
          driftAlerts.push({
            subscriptionName: sub.name,
            alertType: "forgotten",
            detail: `No charge detected since ${sub.lastChargeDate} — may be cancelled or billing cycle changed`,
            suggestedAction: "Verify account status and cancel if no longer needed",
            severity: "info",
          });
        }

        if (sub.frequency === "irregular" && sub.driftPct !== null) {
          driftAlerts.push({
            subscriptionName: sub.name,
            alertType: "irregular_charge",
            detail: `Irregular billing cadence detected (${sub.transactionIds.length} charges)`,
            suggestedAction: "Confirm expected billing schedule with the provider",
            severity: "info",
          });
        }
      }

      // Check for duplicate subscriptions (same monthly cost, different name)
      for (let i = 0; i < subscriptions.length; i++) {
        for (let j = i + 1; j < subscriptions.length; j++) {
          const a = subscriptions[i]!;
          const b = subscriptions[j]!;
          if (
            withinTolerance(a.lastChargeAmount, b.lastChargeAmount, 2) &&
            a.frequency === b.frequency &&
            !merchantsMatch(a.name.toLowerCase(), b.name.toLowerCase())
          ) {
            driftAlerts.push({
              subscriptionName: `${a.name} / ${b.name}`,
              alertType: "duplicate",
              detail: `Both charge ~$${a.lastChargeAmount.toFixed(2)} ${a.frequency} — possible duplicate`,
              suggestedAction: "Confirm both services are intentionally maintained",
              severity: "warning",
            });
          }
        }
      }

      // Sort alerts: alert → warning → info
      const severityOrder = { alert: 0, warning: 1, info: 2 };
      driftAlerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      return {
        subscriptions,
        monthlySubscriptionTotal: round2(monthlyTotal),
        annualSubscriptionTotal: round2(annualTotal),
        driftAlerts,
        nonRecurringTransactionCount: nonRecurringIds.size,
        assumptions,
      };
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
