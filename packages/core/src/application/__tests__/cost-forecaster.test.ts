import { describe, expect, it } from "vitest";
import { CostForecaster, type DayStat, computeForecast } from "../cost-forecaster.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sequentialDays(values: number[]): DayStat[] {
  return values.map((costUsd, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { date: d.toISOString().slice(0, 10), costUsd };
  });
}

// ---------------------------------------------------------------------------
// computeForecast — input validation
// ---------------------------------------------------------------------------

describe("computeForecast — input validation", () => {
  it("throws when history has fewer than 2 entries", () => {
    expect(() => computeForecast([{ date: "2026-01-01", costUsd: 1 }], 30)).toThrow(
      /at least 2 data points/,
    );
  });

  it("throws when history is empty", () => {
    expect(() => computeForecast([], 30)).toThrow(/at least 2 data points/);
  });

  it("throws when horizonDays is 0", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), 0)).toThrow(/positive integer/);
  });

  it("throws when horizonDays is negative", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), -5)).toThrow(/positive integer/);
  });

  it("throws when alpha is out of range (alpha=0)", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), 7, { alpha: 0 })).toThrow(/alpha/);
  });

  it("throws when alpha is out of range (alpha=1)", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), 7, { alpha: 1 })).toThrow(/alpha/);
  });

  it("throws when beta is out of range (beta=0)", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), 7, { beta: 0 })).toThrow(/beta/);
  });

  it("accepts exactly 2 history points", () => {
    expect(() => computeForecast(sequentialDays([1, 2]), 7)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeForecast — output structure
// ---------------------------------------------------------------------------

describe("computeForecast — output structure", () => {
  const history = sequentialDays([0.01, 0.02, 0.015, 0.018, 0.022, 0.019, 0.025]);

  it("returns next7 with exactly 7 points", () => {
    const result = computeForecast(history, 30);
    expect(result.next7).toHaveLength(7);
  });

  it("returns next30 with exactly 30 points", () => {
    const result = computeForecast(history, 30);
    expect(result.next30).toHaveLength(30);
  });

  it("each forecast point has date, costUsd, lower, upper", () => {
    const result = computeForecast(history, 30);
    const pt = result.next7[0];
    expect(pt).toBeDefined();
    if (pt) {
      expect(typeof pt.date).toBe("string");
      expect(typeof pt.costUsd).toBe("number");
      expect(typeof pt.lower).toBe("number");
      expect(typeof pt.upper).toBe("number");
    }
  });

  it("forecast dates are sequential and start the day after the last history date", () => {
    const result = computeForecast(history, 7);
    expect(result.next7[0]?.date).toBe("2026-01-08");
    expect(result.next7[6]?.date).toBe("2026-01-14");
  });

  it("costUsd is never negative", () => {
    const declining = sequentialDays([10, 8, 6, 4, 2, 1, 0.5]);
    const result = computeForecast(declining, 30);
    for (const pt of result.next30) {
      expect(pt.costUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("lower bound is never negative", () => {
    const result = computeForecast(history, 30);
    for (const pt of result.next30) {
      expect(pt.lower).toBeGreaterThanOrEqual(0);
    }
  });

  it("upper bound is >= costUsd for each point", () => {
    const result = computeForecast(history, 30);
    for (const pt of result.next30) {
      expect(pt.upper).toBeGreaterThanOrEqual(pt.costUsd);
    }
  });

  it("prediction interval widens with horizon (h30 > h1)", () => {
    const result = computeForecast(history, 30);
    const width1 = (result.next30[0]?.upper ?? 0) - (result.next30[0]?.lower ?? 0);
    const width30 = (result.next30[29]?.upper ?? 0) - (result.next30[29]?.lower ?? 0);
    expect(width30).toBeGreaterThanOrEqual(width1);
  });
});

// ---------------------------------------------------------------------------
// computeForecast — trend capture
// ---------------------------------------------------------------------------

describe("computeForecast — trend capture", () => {
  it("positive trend: forecasted values rise over horizon", () => {
    // Consistent +1 per day pattern
    const growing = sequentialDays([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = computeForecast(growing, 7);
    const first = result.next7[0]?.costUsd ?? 0;
    const last = result.next7[6]?.costUsd ?? 0;
    expect(last).toBeGreaterThan(first);
    expect(result.trend).toBeGreaterThan(0);
  });

  it("negative trend: forecasted values decrease over horizon", () => {
    // Consistent -1 per day pattern
    const declining = sequentialDays([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const result = computeForecast(declining, 7);
    expect(result.trend).toBeLessThan(0);
  });

  it("flat series: trend is near zero", () => {
    const flat = sequentialDays([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
    const result = computeForecast(flat, 7);
    expect(Math.abs(result.trend)).toBeLessThan(0.001);
  });

  it("projection30dUsd is the sum of all next30 costUsd values", () => {
    const history = sequentialDays([1, 2, 3, 4, 5]);
    const result = computeForecast(history, 30);
    const sum = result.next30.reduce((s, p) => s + p.costUsd, 0);
    expect(result.projection30dUsd).toBeCloseTo(sum, 6);
  });
});

// ---------------------------------------------------------------------------
// computeForecast — alert behaviour
// ---------------------------------------------------------------------------

describe("computeForecast — alert behaviour", () => {
  it("alert is false when monthlyCap is not set", () => {
    const history = sequentialDays([10, 20, 30, 40, 50]);
    const result = computeForecast(history, 30);
    expect(result.alert).toBe(false);
  });

  it("alert is false when projection is below the cap", () => {
    const small = sequentialDays([0.001, 0.002, 0.001, 0.002]);
    const result = computeForecast(small, 30, { monthlyCap: 10_000 });
    expect(result.alert).toBe(false);
  });

  it("alert is true when projection exceeds the cap", () => {
    // Each day costs ~$10, 30-day projection ≈ $300
    const expensive = sequentialDays([10, 10, 10, 10, 10, 10, 10]);
    const result = computeForecast(expensive, 30, { monthlyCap: 1 });
    expect(result.alert).toBe(true);
  });

  it("projection30dUsd is nonnegative", () => {
    const history = sequentialDays([0, 0, 0, 0.001]);
    const result = computeForecast(history, 30);
    expect(result.projection30dUsd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// computeForecast — smoothing parameters
// ---------------------------------------------------------------------------

describe("computeForecast — smoothing parameters", () => {
  const history = sequentialDays([1, 3, 2, 4, 3, 5, 4]);

  it("high alpha reacts more to recent data than low alpha", () => {
    // High alpha: latest spike (4,5,4 at end) should push level up more
    const highAlpha = computeForecast(history, 7, { alpha: 0.9, beta: 0.1 });
    const lowAlpha = computeForecast(history, 7, { alpha: 0.1, beta: 0.1 });
    // Both should produce valid output
    expect(highAlpha.next7[0]?.costUsd).toBeGreaterThanOrEqual(0);
    expect(lowAlpha.next7[0]?.costUsd).toBeGreaterThanOrEqual(0);
    // High alpha should produce different (more reactive) forecasts
    expect(highAlpha.level).not.toBeCloseTo(lowAlpha.level, 2);
  });

  it("level and trend are finite numbers", () => {
    const result = computeForecast(history, 30);
    expect(Number.isFinite(result.level)).toBe(true);
    expect(Number.isFinite(result.trend)).toBe(true);
  });

  it("residualStd is nonnegative", () => {
    const result = computeForecast(history, 30);
    expect(result.residualStd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// CostForecaster class
// ---------------------------------------------------------------------------

describe("CostForecaster class", () => {
  it("forecast() delegates to computeForecast with 30-day horizon", () => {
    const forecaster = new CostForecaster({ alpha: 0.3, beta: 0.1 });
    const history = sequentialDays([1, 2, 3, 4, 5]);
    const result = forecaster.forecast(history);
    expect(result.next30).toHaveLength(30);
    expect(result.next7).toHaveLength(7);
  });

  it("respects monthlyCap passed to constructor", () => {
    const forecaster = new CostForecaster({ monthlyCap: 0.001 });
    const expensive = sequentialDays([100, 100, 100, 100]);
    const result = forecaster.forecast(expensive);
    expect(result.alert).toBe(true);
  });

  it("uses default alpha/beta when not specified", () => {
    const forecaster = new CostForecaster();
    const history = sequentialDays([1, 2, 3]);
    expect(() => forecaster.forecast(history)).not.toThrow();
  });
});
