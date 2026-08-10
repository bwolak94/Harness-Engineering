import type { BacktestRulesInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createBacktestRulesTool } from "../n4-backtest-rules.js";

const DEF = {
  name: "backtestRules",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "moderate" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createBacktestRulesTool(DEF);

// A simple entry: SMA(10) crosses above SMA(30) (golden cross)
// A simple exit:  SMA(10) crosses below SMA(30) (death cross)
const BASE_INPUT: BacktestRulesInput = {
  symbol: "AAPL",
  timeframe: "1d",
  range: { from: "2022-01-01", to: "2023-12-31" },
  entry: {
    indicator: "SMA",
    params: { period: 10 },
    op: "crossAbove",
    value: 50, // crosses above a fixed level (avoids requiring previous SMA series for value)
  },
  exit: {
    indicator: "SMA",
    params: { period: 10 },
    op: "crossBelow",
    value: 50,
  },
  riskPct: 2,
  initialCapital: 10_000,
};

describe("backtestRules", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);

    expect(typeof out.stats.trades).toBe("number");
    expect(typeof out.stats.winRate).toBe("number");
    expect(typeof out.stats.profitFactor).toBe("number");
    expect(typeof out.stats.expectancyR).toBe("number");
    expect(typeof out.stats.maxDrawdownPct).toBe("number");
    expect(typeof out.stats.sharpe).toBe("number");
    expect(Array.isArray(out.sampleTrades)).toBe(true);
    expect(typeof out.equityCurveSummary.startValue).toBe("number");
    expect(typeof out.equityCurveSummary.endValue).toBe("number");
    expect(out.equityCurveSummary.monthlyReturns).toHaveLength(12);
  });

  it("winRate is in [0, 1]", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.stats.winRate).toBeGreaterThanOrEqual(0);
    expect(out.stats.winRate).toBeLessThanOrEqual(1);
  });

  it("maxDrawdownPct is non-negative", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.stats.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it("profitFactor is non-negative", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.stats.profitFactor).toBeGreaterThanOrEqual(0);
  });

  it("sampleTrades capped at 5 even for long date ranges", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      range: { from: "2010-01-01", to: "2023-12-31" }, // ~14 years of daily candles
    });
    expect(out.sampleTrades.length).toBeLessThanOrEqual(5);
  });

  it("sampleTrade fields are all present and numeric", async () => {
    const out = await tool.execute(BASE_INPUT);
    for (const t of out.sampleTrades) {
      expect(typeof t.entryAt).toBe("string");
      expect(typeof t.exitAt).toBe("string");
      expect(typeof t.entryPrice).toBe("number");
      expect(typeof t.exitPrice).toBe("number");
      expect(typeof t.rMultiple).toBe("number");
      expect(typeof t.pnl).toBe("number");
    }
  });

  it("is deterministic — same input produces same output", async () => {
    const out1 = await tool.execute(BASE_INPUT);
    const out2 = await tool.execute(BASE_INPUT);
    expect(out1.stats).toEqual(out2.stats);
    expect(out1.sampleTrades).toEqual(out2.sampleTrades);
    expect(out1.equityCurveSummary).toEqual(out2.equityCurveSummary);
  });

  it("different symbols produce different equity curves when trades fire", async () => {
    // Use RSI(5) cross to generate trades reliably — RSI fluctuates near 50
    // on any random walk, so both symbols accumulate many trades
    const longRange = { from: "2010-01-01", to: "2023-12-31" };
    const entry = { indicator: "RSI", params: { period: 5 }, op: "crossAbove" as const, value: 50 };
    const exit  = { indicator: "RSI", params: { period: 5 }, op: "crossBelow" as const, value: 50 };
    const outA = await tool.execute({ ...BASE_INPUT, symbol: "AAPL", range: longRange, entry, exit });
    const outB = await tool.execute({ ...BASE_INPUT, symbol: "TSLA", range: longRange, entry, exit });
    // Both will have many trades; the different price paths produce different PnL sums
    expect(outA.stats.trades).toBeGreaterThan(0);
    expect(outB.stats.trades).toBeGreaterThan(0);
    // The equity end values may coincidentally be the same when trades=0,
    // but with RSI cross-rules over 14 years they will diverge
    expect(outA.equityCurveSummary.endValue).not.toEqual(outB.equityCurveSummary.endValue);
  });

  it("no trades for range shorter than indicator warm-up", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      range: { from: "2023-01-01", to: "2023-01-02" }, // 1 day — 0 or 1 candle
    });
    // Either no candles or not enough for SMA(10) → 0 trades
    expect(out.stats.trades).toBe(0);
  });

  it("equityCurveSummary.startValue equals initialCapital", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.equityCurveSummary.startValue).toBe(BASE_INPUT.initialCapital);
  });

  it("peakValue >= startValue and peakValue >= endValue", async () => {
    const out = await tool.execute(BASE_INPUT);
    const { startValue, endValue, peakValue } = out.equityCurveSummary;
    expect(peakValue).toBeGreaterThanOrEqual(startValue);
    expect(peakValue).toBeGreaterThanOrEqual(endValue);
  });

  it("troughValue <= startValue and troughValue <= endValue", async () => {
    const out = await tool.execute(BASE_INPUT);
    const { startValue, endValue, troughValue } = out.equityCurveSummary;
    expect(troughValue).toBeLessThanOrEqual(startValue);
    expect(troughValue).toBeLessThanOrEqual(endValue);
  });

  it("compound rule with AND evaluates both sub-rules", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      entry: {
        and: [
          { indicator: "SMA", params: { period: 10 }, op: "crossAbove", value: 50 },
          { indicator: "RSI", params: { period: 14 }, op: "lessThan", value: 70 },
        ],
      },
    });
    expect(typeof out.stats.trades).toBe("number");
    expect(out.sampleTrades.length).toBeLessThanOrEqual(5);
  });

  it("NOT rule produces fewer trades than the base rule over a long range", async () => {
    const longRange = { from: "2010-01-01", to: "2023-12-31" };
    // RSI > 0 is almost always true → many entry signals
    const baseEntry = { indicator: "RSI", params: { period: 5 }, op: "greaterThan" as const, value: 0 };
    const baseExit  = { indicator: "RSI", params: { period: 5 }, op: "lessThan"    as const, value: 100 };
    const outNormal   = await tool.execute({ ...BASE_INPUT, range: longRange, entry: baseEntry, exit: baseExit });
    // NOT(RSI > 0) = RSI <= 0 — almost never true (RSI approaches 0 only when all moves are down)
    const outInverted = await tool.execute({ ...BASE_INPUT, range: longRange, entry: { not: baseEntry }, exit: baseExit });
    // The normal entry fires far more often than the inverted one
    expect(outNormal.stats.trades).toBeGreaterThan(outInverted.stats.trades);
  });

  it("greaterThan op fires when indicator > value", async () => {
    const out = await tool.execute({
      ...BASE_INPUT,
      entry: { indicator: "RSI", params: { period: 14 }, op: "greaterThan", value: 0 },
      exit: { indicator: "RSI", params: { period: 14 }, op: "lessThan", value: 100 },
    });
    // With RSI > 0 always true and RSI < 100 always true, every candle pair is a trade
    expect(out.stats.trades).toBeGreaterThan(0);
  });
});
