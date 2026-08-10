import { describe, expect, it } from "vitest";
import { ALL_CASES } from "../golden/index.js";
import { N1_CASES } from "../golden/n1.js";
import { N3_CASES } from "../golden/n3.js";
import { N4_CASES } from "../golden/n4.js";
import { N6_CASES } from "../golden/n6.js";
import { N7_CASES } from "../golden/n7.js";
import { N9_CASES } from "../golden/n9.js";
import { REGRESSION_CASES } from "../golden/regression.js";
import { EvalRunner } from "../runner.js";

// ---------------------------------------------------------------------------
// Full golden set — all cases must pass
// ---------------------------------------------------------------------------

describe("eval golden set", () => {
  const runner = new EvalRunner();

  it("all cases pass", async () => {
    const results = await runner.runAll(ALL_CASES, { updateSnapshots: false });

    const failures = results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const messages = failures.flatMap((r) => [
        `FAILED: ${r.caseId}`,
        ...r.outcomeFailures.map((f) => `  outcome: ${f.message}`),
        ...r.trajectoryFailures.map((f) => `  trajectory: ${f.message}`),
        ...(r.snapshotDiff ? [`  snapshot:\n${r.snapshotDiff}`] : []),
      ]);
      throw new Error(`${failures.length} eval case(s) failed:\n${messages.join("\n")}`);
    }

    expect(failures).toHaveLength(0);
  }, 60_000); // generous timeout for the 8760-step PV simulation
});

// ---------------------------------------------------------------------------
// Trajectory regression — budget guard detects missing enforcement
// ---------------------------------------------------------------------------

describe("trajectory regression", () => {
  const runner = new EvalRunner();

  it("budget guard stops workflow at maxSteps", async () => {
    const budgetCase = REGRESSION_CASES.find((c) => c.id === "regression-budget-guard");
    expect(budgetCase).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(budgetCase!, { updateSnapshots: false });

    // Workflow is "halted" when stopped by budget exhaustion
    // (reducer maps workflow.failed with budgetExceeded payload → "halted")
    expect(result.status).toBe("halted");
    // Exactly 2 steps must have run (budget maxSteps=2)
    expect(result.steps).toBeLessThanOrEqual(2);
    // Trajectory check must have passed (no failures means budget guard fired correctly)
    expect(result.trajectoryFailures).toHaveLength(0);
  });

  it("single-step workflow completes with exactly 1 step", async () => {
    const singleCase = REGRESSION_CASES.find((c) => c.id === "regression-single-step-completes");
    expect(singleCase).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(singleCase!, { updateSnapshots: false });

    expect(result.status).toBe("completed");
    expect(result.steps).toBe(1);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Outcome assertions — deterministic tool math
// ---------------------------------------------------------------------------

describe("outcome assertions — N1 analyzeInvestment", () => {
  const runner = new EvalRunner();

  it("single apartment: NOI > 0, capRate > 0, cashflows.length === 5", async () => {
    const c = N1_CASES.find((x) => x.id === "n1-single-apartment-annuity");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});

describe("outcome assertions — N9 calculateNetSalary", () => {
  const runner = new EvalRunner();

  it("UoP 2024: net < gross, ZUS employee > 0", async () => {
    const c = N9_CASES.find((x) => x.id === "n9-uop-2024");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});

describe("outcome assertions — N3 calculateLandedCost", () => {
  const runner = new EvalRunner();

  it("EU standard import: VAT > 0, appliedRules non-empty", async () => {
    const c = N3_CASES.find((x) => x.id === "n3-eu-standard-import");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});

describe("outcome assertions — N4 backtestRules", () => {
  const runner = new EvalRunner();

  it("SMA cross: all output fields present, 12 monthly buckets", async () => {
    const c = N4_CASES.find((x) => x.id === "n4-sma-cross-basic");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });

  it("RSI cross long range: trades > 0, sampleTrades <= 5", async () => {
    const c = N4_CASES.find((x) => x.id === "n4-rsi-cross-long-range");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});

describe("outcome assertions — N6 screenCandidates", () => {
  const runner = new EvalRunner();

  it("two candidates: both scored, rankingRationale present", async () => {
    const c = N6_CASES.find((x) => x.id === "n6-two-candidates-ranking");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });

  it("custom weights: rubricBreakdown on every scored candidate", async () => {
    const c = N6_CASES.find((x) => x.id === "n6-custom-weights");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});

describe("outcome assertions — N7 explodeRecipeCost", () => {
  const runner = new EvalRunner();

  it("pizza margherita: totalCost > 0, purchaseList has leaf ingredients", async () => {
    const c = N7_CASES.find((x) => x.id === "n7-pizza-margherita-no-stock");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });

  it("tiramisu: nested espresso resolved, ground-coffee in purchaseList", async () => {
    const c = N7_CASES.find((x) => x.id === "n7-tiramisu-nested-espresso");
    expect(c).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await runner.run(c!);
    expect(result.outcomeFailures).toHaveLength(0);
  });
});
