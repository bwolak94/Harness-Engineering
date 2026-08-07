import { describe, expect, it } from "vitest";
import type { BudgetUsage } from "../domain/workflow-state.js";
import { BudgetEnforcer } from "./budget-enforcer.js";

const BUDGET = {
  maxTokens: 1000,
  maxSteps: 5,
  maxWallClockMs: 30_000,
  maxCostUsd: 1.0,
};

const ZERO_USAGE: BudgetUsage = {
  tokensUsed: 0,
  stepsCompleted: 0,
  wallClockMs: 0,
  costUsd: 0,
};

describe("BudgetEnforcer.check", () => {
  it("returns null when all counters are below limits", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    expect(enforcer.check(ZERO_USAGE)).toBeNull();
  });

  it("returns null when exactly at limit minus one", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const usage: BudgetUsage = {
      tokensUsed: 999,
      stepsCompleted: 4,
      wallClockMs: 29_999,
      costUsd: 0.999,
    };
    expect(enforcer.check(usage)).toBeNull();
  });

  it("detects tokens budget exceeded", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const result = enforcer.check({ ...ZERO_USAGE, tokensUsed: 1000 });
    expect(result).toEqual({ reason: "tokens", limit: 1000, actual: 1000 });
  });

  it("detects steps budget exceeded", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const result = enforcer.check({ ...ZERO_USAGE, stepsCompleted: 5 });
    expect(result).toEqual({ reason: "steps", limit: 5, actual: 5 });
  });

  it("detects wallClock budget exceeded", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const result = enforcer.check({ ...ZERO_USAGE, wallClockMs: 30_000 });
    expect(result).toEqual({ reason: "wallClock", limit: 30_000, actual: 30_000 });
  });

  it("detects costUsd budget exceeded", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const result = enforcer.check({ ...ZERO_USAGE, costUsd: 1.0 });
    expect(result).toEqual({ reason: "costUsd", limit: 1.0, actual: 1.0 });
  });

  it("returns first exceeded limit (tokens checked before steps)", () => {
    const enforcer = new BudgetEnforcer(BUDGET);
    const result = enforcer.check({
      tokensUsed: 1001,
      stepsCompleted: 6,
      wallClockMs: 0,
      costUsd: 0,
    });
    // tokens is checked first in the implementation
    expect(result?.reason).toBe("tokens");
  });

  it("each of the four budgets independently stops execution", () => {
    const reasons = ["tokens", "steps", "wallClock", "costUsd"] as const;
    const usages: BudgetUsage[] = [
      { ...ZERO_USAGE, tokensUsed: 9999 },
      { ...ZERO_USAGE, stepsCompleted: 9999 },
      { ...ZERO_USAGE, wallClockMs: 9_999_999 },
      { ...ZERO_USAGE, costUsd: 9999 },
    ];

    for (const [i, usage] of usages.entries()) {
      const enforcer = new BudgetEnforcer(BUDGET);
      const result = enforcer.check(usage);
      expect(result?.reason).toBe(reasons[i]);
    }
  });
});
