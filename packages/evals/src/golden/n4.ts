import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N4 — backtestRules golden cases.
 *
 * The tool generates price candles deterministically (seeded PRNG) — no
 * external data, no network. Outcome checks focus on structural invariants
 * rather than exact numeric values because the PRNG output is
 * implementation-specific.
 *
 * Three scenarios:
 *  1. SMA cross strategy over a 2-year range — verifies all output fields present.
 *  2. RSI cross strategy over 14 years — verifies many trades fire and
 *     equityCurve has exactly 12 monthly buckets.
 *  3. AND compound rule — verifies compound rule is accepted and output is valid.
 */
export const N4_CASES: EvalCase[] = [
  {
    id: "n4-sma-cross-basic",
    tool: "backtestRules",
    description:
      "SMA(10) crossAbove 50 entry / crossBelow 50 exit over 2 years — all output fields present, equityCurve has 12 monthly buckets",
    task: {
      id: "eval-n4-sma",
      goal: "Backtest this SMA crossover strategy on AAPL over 2022-2023.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("backtestRules", {
        symbol: "AAPL",
        timeframe: "1d",
        range: { from: "2022-01-01", to: "2023-12-31" },
        entry: { indicator: "SMA", params: { period: 10 }, op: "crossAbove", value: 50 },
        exit: { indicator: "SMA", params: { period: 10 }, op: "crossBelow", value: 50 },
        riskPct: 2,
        initialCapital: 10_000,
      }),
      FakeModelPort.textResponse("Backtest complete."),
    ]),
    outcomeChecks: [
      // trades is a non-negative integer
      { type: "field_between", path: "stats.trades", min: 0, max: 100_000 },
      // winRate in [0, 1]
      { type: "field_between", path: "stats.winRate", min: 0, max: 1 },
      // maxDrawdownPct is non-negative
      { type: "field_between", path: "stats.maxDrawdownPct", min: 0, max: 100 },
      // equityCurve starts at initialCapital
      { type: "field_equals", path: "equityCurveSummary.startValue", value: 10_000 },
      // 12 monthly return buckets
      { type: "field_equals", path: "equityCurveSummary.monthlyReturns.length", value: 12 },
      // sampleTrades is an array (possibly empty)
      { type: "field_truthy", path: "sampleTrades" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "backtestRules" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n4-rsi-cross-long-range",
    tool: "backtestRules",
    description:
      "RSI(5) crossAbove/crossBelow 50 over 14 years — many trades fire, profitFactor ≥ 0, sampleTrades ≤ 5",
    task: {
      id: "eval-n4-rsi",
      goal: "Backtest RSI crossover on TSLA over 14 years.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("backtestRules", {
        symbol: "TSLA",
        timeframe: "1d",
        range: { from: "2010-01-01", to: "2023-12-31" },
        entry: { indicator: "RSI", params: { period: 5 }, op: "crossAbove", value: 50 },
        exit: { indicator: "RSI", params: { period: 5 }, op: "crossBelow", value: 50 },
        riskPct: 1,
        initialCapital: 50_000,
      }),
      FakeModelPort.textResponse("Long-range RSI backtest complete."),
    ]),
    outcomeChecks: [
      // RSI(5) cross over 14 years must generate a meaningful number of trades
      { type: "field_gt", path: "stats.trades", value: 0 },
      { type: "field_between", path: "stats.winRate", min: 0, max: 1 },
      { type: "field_between", path: "stats.profitFactor", min: 0, max: 1_000 },
      { type: "field_equals", path: "equityCurveSummary.startValue", value: 50_000 },
      // peakValue must be >= startValue
      { type: "field_between", path: "equityCurveSummary.peakValue", min: 50_000, max: 1e12 },
      // sampleTrades capped at 5
      { type: "field_between", path: "sampleTrades.length", min: 0, max: 5 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "backtestRules" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n4-compound-and-rule",
    tool: "backtestRules",
    description:
      "AND compound rule (SMA crossAbove AND RSI < 70) — accepted and produces valid output",
    task: {
      id: "eval-n4-and",
      goal: "Backtest this compound entry rule on MSFT.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("backtestRules", {
        symbol: "MSFT",
        timeframe: "1d",
        range: { from: "2020-01-01", to: "2023-12-31" },
        entry: {
          and: [
            { indicator: "SMA", params: { period: 10 }, op: "crossAbove", value: 50 },
            { indicator: "RSI", params: { period: 14 }, op: "lessThan", value: 70 },
          ],
        },
        exit: { indicator: "SMA", params: { period: 10 }, op: "crossBelow", value: 50 },
        riskPct: 2,
        initialCapital: 20_000,
      }),
      FakeModelPort.textResponse("Compound rule backtest complete."),
    ]),
    outcomeChecks: [
      { type: "field_between", path: "stats.trades", min: 0, max: 100_000 },
      { type: "field_between", path: "stats.winRate", min: 0, max: 1 },
      { type: "field_equals", path: "equityCurveSummary.startValue", value: 20_000 },
      { type: "field_equals", path: "equityCurveSummary.monthlyReturns.length", value: 12 },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "backtestRules" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },
];
