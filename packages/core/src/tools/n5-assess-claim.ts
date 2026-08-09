import type { ToolDefinition } from "@harness/contracts";
import {
  type AssessClaimInput,
  AssessClaimInputSchema,
  type AssessClaimOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// N5 — assessClaim
//
// Evaluates an insurance claim deterministically:
//   1. Depreciation from the age-based table.
//   2. Underinsurance factor when estimated loss > sum insured.
//   3. Deductible: integral (waived below threshold) or reductive (always subtracted).
//   4. Category limits cap the final payout.
//
// The tool is PURE — no side effects, no I/O, no threshold policy.
// The HITL approval gate (amount > threshold) lives in the ToolPolicy at the
// composition root so the limit can change without a deploy.
// ---------------------------------------------------------------------------

function findDepreciation(
  itemAge: number,
  table: AssessClaimInput["policy"]["depreciationTable"],
): number {
  const row = table.find((r) => r.ageYearsFrom <= itemAge && itemAge < r.ageYearsTo);
  return row?.depreciationPct ?? 0;
}

function findCategoryLimit(
  claimType: string,
  limits: AssessClaimInput["policy"]["limits"],
): number | null {
  const limit = limits.find((l) => l.category.toLowerCase() === claimType.toLowerCase());
  return limit?.maxAmount ?? null;
}

export function createAssessClaimTool(
  definition: ToolDefinition,
): Tool<AssessClaimInput, AssessClaimOutput> {
  return {
    definition,
    inputSchema: AssessClaimInputSchema,

    async execute(input: AssessClaimInput): Promise<AssessClaimOutput> {
      const { policy, claim } = input;
      const reasons: string[] = [];

      // 1. Depreciation
      const depreciationPct = findDepreciation(claim.itemAge, policy.depreciationTable);
      const depreciation = (claim.estimatedLoss * depreciationPct) / 100;
      if (depreciation > 0) {
        reasons.push(`Depreciation ${depreciationPct}% applied (item age: ${claim.itemAge} years): -${depreciation.toFixed(2)}`);
      }

      const lossAfterDepreciation = claim.estimatedLoss - depreciation;

      // 2. Underinsurance factor
      const underinsuranceFactor =
        claim.estimatedLoss > policy.sumInsured
          ? policy.sumInsured / claim.estimatedLoss
          : 1.0;

      if (underinsuranceFactor < 1) {
        reasons.push(
          `Underinsurance factor ${underinsuranceFactor.toFixed(4)} applied ` +
            `(insured: ${policy.sumInsured}, estimated loss: ${claim.estimatedLoss})`,
        );
      }

      const adjustedLoss = lossAfterDepreciation * underinsuranceFactor;

      // 3. Deductible
      let payoutAfterDeductible: number;
      const deductibleApplied: number = policy.deductible;

      if (policy.deductibleType === "integral") {
        // Integral: deductible only applies when adjusted loss > deductible
        if (adjustedLoss <= policy.deductible) {
          payoutAfterDeductible = 0;
          reasons.push(`Integral deductible ${policy.deductible}: claim fully absorbed (loss ${adjustedLoss.toFixed(2)} ≤ deductible)`);
        } else {
          payoutAfterDeductible = adjustedLoss - policy.deductible;
          reasons.push(`Integral deductible applied: -${policy.deductible}`);
        }
      } else {
        // Reductive: always subtract, floor at 0
        payoutAfterDeductible = Math.max(0, adjustedLoss - policy.deductible);
        if (policy.deductible > 0) {
          reasons.push(`Reductive deductible applied: -${policy.deductible}`);
        }
      }

      // 4. Category limit
      const categoryLimit = findCategoryLimit(claim.type, policy.limits);
      let payout = payoutAfterDeductible;

      if (categoryLimit !== null && payout > categoryLimit) {
        reasons.push(`Category limit '${claim.type}': capped at ${categoryLimit}`);
        payout = categoryLimit;
      }

      // Round to 2 decimal places for a stable monetary output
      payout = Math.round(payout * 100) / 100;

      // 5. Decision
      let decision: AssessClaimOutput["decision"];
      if (payout <= 0) {
        decision = "reject";
        reasons.push("Decision: reject — zero payout after all adjustments");
      } else if (input.evidence.length === 0) {
        decision = "review";
        reasons.push("Decision: review — no evidence documents provided");
      } else {
        decision = "approve";
      }

      return {
        decision,
        payout,
        deductibleApplied: payoutAfterDeductible < adjustedLoss ? deductibleApplied : 0,
        underinsuranceFactor: Math.round(underinsuranceFactor * 10000) / 10000,
        depreciation: Math.round(depreciation * 100) / 100,
        reasons,
      };
    },
  };
}
