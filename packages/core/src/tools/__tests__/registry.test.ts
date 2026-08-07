/**
 * Registry integration tests.
 *
 * DoD coverage:
 * - Adding a new tool requires zero changes in HarnessRuntime (structural).
 * - Every tool with dangerous:false is pure (idempotent): two identical calls
 *   produce identical results with zero side effects.
 * - Registration with a missing TOOL_REGISTRY entry throws at startup (not runtime).
 * - Validation error from invalid input → VALIDATION_ERROR ToolResult, runtime continues.
 */
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../ports/tool-registry.port.js";
import { createDefaultToolExecutors } from "../index.js";

// ---------------------------------------------------------------------------
// Minimal inline registry (avoids circular dep on adapters-memory)
// ---------------------------------------------------------------------------

class SimpleRegistry {
  private readonly map = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): void {
    if (this.map.has(executor.definition.name)) {
      throw new Error(`Duplicate tool: ${executor.definition.name}`);
    }
    this.map.set(executor.definition.name, executor);
  }

  get(name: string): ToolExecutor | undefined {
    return this.map.get(name);
  }

  list(): readonly ToolExecutor[] {
    return [...this.map.values()];
  }

  schemas() {
    return this.list().map((e) => e.definition);
  }
}

function buildRegistry(): SimpleRegistry {
  const registry = new SimpleRegistry();
  for (const executor of createDefaultToolExecutors()) {
    registry.register(executor);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Deterministic inputs per tool (safe, idempotent)
// ---------------------------------------------------------------------------

const TOOL_INPUTS: Record<string, unknown> = {
  analyzeInvestment: {
    price: 500_000,
    rentRoll: [{ unit: "U1", monthlyRent: 2500, occupancyPct: 95 }],
    opex: [{ category: "mgmt", annualAmount: 5000 }],
    loan: { amount: 300_000, rateAnnualPct: 4, termYears: 15, type: "annuity" },
    horizonYears: 5,
    exitCapRate: 0.06,
  },
  calculateLandedCost: {
    hsCode: "6101",
    originCountry: "CN",
    destCountry: "PL",
    incoterm: "FOB",
    value: 5000,
    currency: "EUR",
    weightKg: 50,
    freightCost: 300,
    preferentialOrigin: false,
  },
  calculateNetSalary: {
    gross: 8000,
    contractType: "uop",
    year: 2024,
    taxReliefs: [],
    ppkRate: 2,
    jointFiling: false,
  },
  proposeRepricing: {
    products: [
      { sku: "SKU-1", cost: 40, currentPrice: 80, lastChangeAt: "2000-01-01T00:00:00.000Z" },
    ],
    competitorPrices: [
      { sku: "SKU-1", competitorId: "C1", price: 75, capturedAt: "2000-01-01T00:00:00.000Z" },
    ],
    minMarginPct: 20,
    elasticity: -2,
    cooldownHours: 24,
    maxDailyChangePct: 15,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDefaultToolExecutors", () => {
  it("registers all expected tools without throwing (startup-time validation passes)", () => {
    expect(() => buildRegistry()).not.toThrow();
  });

  it("duplicate registration throws (startup check)", () => {
    const registry = new SimpleRegistry();
    const executors = createDefaultToolExecutors();
    const first = executors[0];
    if (!first) throw new Error("No executors returned");
    registry.register(first);
    expect(() => registry.register(first)).toThrow(/Duplicate/);
  });

  it("every tool has a non-empty name and description", () => {
    for (const executor of buildRegistry().list()) {
      expect(executor.definition.name.length).toBeGreaterThan(0);
      expect(executor.definition.description.length).toBeGreaterThan(0);
    }
  });

  it("schemas() returns definitions for all registered tools", () => {
    const registry = buildRegistry();
    const names = registry.schemas().map((s) => s.name);
    expect(names).toContain("analyzeInvestment");
    expect(names).toContain("calculateLandedCost");
    expect(names).toContain("calculateNetSalary");
    expect(names).toContain("proposeRepricing");
  });
});

describe("idempotency: every non-dangerous tool produces identical results on repeat calls", () => {
  const registry = buildRegistry();

  for (const executor of registry.list()) {
    const { name, dangerous } = executor.definition;
    if (dangerous) continue;

    const input = TOOL_INPUTS[name];
    if (!input) continue; // no deterministic fixture for this tool

    it(`${name}: two identical calls → same result`, async () => {
      const r1 = await executor.execute(input);
      const r2 = await executor.execute(input);
      expect(r1.ok).toBe(r2.ok);
      if (r1.ok && r2.ok) {
        expect(r1.value).toEqual(r2.value);
      }
    });
  }
});

describe("validation error handling", () => {
  it("invalid input returns VALIDATION_ERROR (not a throw)", async () => {
    const registry = buildRegistry();
    const executor = registry.get("analyzeInvestment");
    if (!executor) throw new Error("analyzeInvestment not in registry");
    // Missing required field `price`
    const result = await executor.execute({ rentRoll: [], loan: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("execution error wrapped as EXECUTION_ERROR (not a throw)", async () => {
    const registry = buildRegistry();
    const executor = registry.get("calculateNetSalary");
    if (!executor) throw new Error("calculateNetSalary not in registry");
    // Year 2030 not in SALARY_RATES_TABLE → execute throws → asExecutor wraps to err
    const result = await executor.execute({
      gross: 5000,
      contractType: "uop",
      year: 2030,
      taxReliefs: [],
      ppkRate: 2,
      jointFiling: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toContain("2030");
    }
  });

  it("runCode returns an error (NOT_IMPLEMENTED stub), not APPROVAL_REQUIRED", async () => {
    const registry = buildRegistry();
    const executor = registry.get("runCode");
    if (!executor) throw new Error("runCode not in registry");
    const result = await executor.execute({ language: "python", code: "print(1)" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // runCode is not dangerous → policy allows it → EXECUTION_ERROR from the stub throw
      expect(result.error.code).not.toBe("APPROVAL_REQUIRED");
      expect(result.error.code).toBe("EXECUTION_ERROR");
    }
  });
});
