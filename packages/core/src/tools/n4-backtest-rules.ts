import type { ToolDefinition } from "@harness/contracts";
import {
  type BacktestRulesInput,
  BacktestRulesInputSchema,
  type BacktestRulesOutput,
  type RuleExpr,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// N4 — backtestRules
//
// Walk-forward backtest of entry/exit trading rules on synthetic candle data.
//
// KEY DESIGN DECISION — no external data source:
//   The tool generates deterministic synthetic OHLC candles from the symbol name,
//   timeframe, and date range using a seeded LCG pseudo-random number generator.
//   This is the "fixture provider" pattern from plan.md: zero network I/O,
//   fully reproducible, testable without mocking.
//
// Key constraints (per plan.md):
//   - Returns statistics and UP TO 5 sample trades — never the full trade list.
//     A full list of 400+ trades would exhaust the model's context in one step.
//   - equityCurveSummary replaces the raw equity array for the same reason.
//
// Exercises:
//   - T03: truncation — the raw trade list is never returned
//   - (T08 optional): model can write a sandbox script to transform candle data
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic PRNG — LCG (linear congruential generator)
// ---------------------------------------------------------------------------

/** djb2 hash — maps a string to a uint32 seed. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h || 1; // never return 0 — LCG degenerates on 0 seed
}

class LCG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** Returns a uniform float in [0, 1). */
  next(): number {
    this.s = (Math.imul(1664525, this.s) + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }

  /** Standard normal via Box-Muller transform. */
  gaussian(): number {
    const u1 = this.next() || 1e-10; // avoid log(0)
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ---------------------------------------------------------------------------
// Candle generation
// ---------------------------------------------------------------------------

interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const TIMEFRAME_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

// Annualised volatility per candle (lower timeframe → lower per-candle vol)
const TIMEFRAME_VOL: Record<string, number> = {
  "1m": 0.0004,
  "5m": 0.0009,
  "15m": 0.0015,
  "1h": 0.003,
  "4h": 0.006,
  "1d": 0.014,
};

/** Maximum candles we generate to keep execution bounded. */
const MAX_CANDLES = 100_000;

function generateCandles(symbol: string, timeframe: string, from: string, to: string): Candle[] {
  const intervalMs = TIMEFRAME_INTERVAL_MS[timeframe] ?? 86_400_000;
  const vol = TIMEFRAME_VOL[timeframe] ?? 0.014;

  const fromTs = new Date(from).getTime();
  const toTs = new Date(to).getTime();
  const rangeMs = Math.max(0, toTs - fromTs);
  const count = Math.min(Math.floor(rangeMs / intervalMs), MAX_CANDLES);

  if (count === 0) return [];

  const seed = djb2(`${symbol}:${timeframe}:${from}`);
  const rng = new LCG(seed);

  // Base price: deterministic per symbol (between 10 and 200)
  const basePrice = 10 + (djb2(symbol) % 191);

  const candles: Candle[] = [];
  let prevClose = basePrice;

  for (let i = 0; i < count; i++) {
    const ts = new Date(fromTs + i * intervalMs).toISOString();

    // Log-normal return with tiny upward drift (realistic GBM)
    const logReturn = 0.00005 + vol * rng.gaussian();
    const close = Math.max(0.01, prevClose * Math.exp(logReturn));

    // Intracandle noise: open slightly gaps from prev close
    const open = Math.max(0.01, prevClose * (1 + vol * 0.2 * rng.gaussian()));

    // Wicks: symmetric half-vol on each side
    const wick = Math.max(open, close) * vol * 0.6;
    const high = Math.max(open, close) + Math.abs(rng.gaussian()) * wick;
    const low = Math.max(0.01, Math.min(open, close) - Math.abs(rng.gaussian()) * wick);

    candles.push({ ts, open, high, low, close });
    prevClose = close;
  }

  return candles;
}

// ---------------------------------------------------------------------------
// Indicator engine (pre-computed series to avoid O(n²) on large datasets)
// ---------------------------------------------------------------------------

type IndicatorSeries = Float64Array;

function computeSma(closes: Float64Array, period: number): Float64Array {
  const result = new Float64Array(closes.length).fill(Number.NaN);
  if (period <= 0 || period > closes.length) return result;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i] ?? 0;
    if (i >= period) sum -= closes[i - period] ?? 0;
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function computeEma(closes: Float64Array, period: number): Float64Array {
  const result = new Float64Array(closes.length).fill(Number.NaN);
  if (period <= 0 || closes.length < period) return result;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i] ?? 0;
  ema /= period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] ?? 0) * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function computeRsi(closes: Float64Array, period: number): Float64Array {
  const result = new Float64Array(closes.length).fill(Number.NaN);
  if (period <= 0 || closes.length < period + 1) return result;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff > 0) avgGain += diff / period;
    else avgLoss += -diff / period;
  }
  result[period] = 100 - 100 / (1 + (avgLoss === 0 ? Number.POSITIVE_INFINITY : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function getIndicatorSeries(
  name: string,
  params: Record<string, unknown> | undefined,
  closes: Float64Array,
  cache: Map<string, IndicatorSeries>,
): IndicatorSeries {
  const period = Math.max(1, Math.round(Number(params?.period ?? 14)));
  const key = `${name.toUpperCase()}:${period}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let series: IndicatorSeries;
  switch (name.toUpperCase()) {
    case "SMA":
      series = computeSma(closes, period);
      break;
    case "EMA":
      series = computeEma(closes, period);
      break;
    case "RSI":
      series = computeRsi(closes, period);
      break;
    default:
      series = closes.slice(); // unknown indicator → treat as price
  }
  cache.set(key, series);
  return series;
}

// ---------------------------------------------------------------------------
// Rule evaluator — walks the RuleExpr DSL
// ---------------------------------------------------------------------------

function resolveValue(val: number | string, closes: Float64Array, i: number): number {
  if (typeof val === "number") return val;
  // "price" or any unknown string → current close price
  return closes[i] ?? Number.NaN;
}

function evalRule(
  rule: RuleExpr,
  closes: Float64Array,
  cache: Map<string, IndicatorSeries>,
  i: number,
): boolean {
  if ("and" in rule) return rule.and.every((r) => evalRule(r, closes, cache, i));
  if ("or" in rule) return rule.or.some((r) => evalRule(r, closes, cache, i));
  if ("not" in rule) return !evalRule(rule.not, closes, cache, i);

  // Atomic rule: { indicator, params, op, value }
  const lhsSeries = getIndicatorSeries(rule.indicator, rule.params, closes, cache);
  const lhsCurr = lhsSeries[i] ?? Number.NaN;
  const lhsPrev = i > 0 ? (lhsSeries[i - 1] ?? Number.NaN) : Number.NaN;

  const rhsCurr = resolveValue(rule.value, closes, i);
  const rhsPrev = i > 0 ? resolveValue(rule.value, closes, i - 1) : Number.NaN;

  if (Number.isNaN(lhsCurr) || Number.isNaN(rhsCurr)) return false;

  switch (rule.op) {
    case "crossAbove":
      return (
        lhsCurr > rhsCurr && !Number.isNaN(lhsPrev) && !Number.isNaN(rhsPrev) && lhsPrev <= rhsPrev
      );
    case "crossBelow":
      return (
        lhsCurr < rhsCurr && !Number.isNaN(lhsPrev) && !Number.isNaN(rhsPrev) && lhsPrev >= rhsPrev
      );
    case "greaterThan":
      return lhsCurr > rhsCurr;
    case "lessThan":
      return lhsCurr < rhsCurr;
    case "equals":
      return Math.abs(lhsCurr - rhsCurr) < 1e-9;
  }
}

// ---------------------------------------------------------------------------
// Trade simulation
// ---------------------------------------------------------------------------

interface TradeRecord {
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  rMultiple: number;
  pnl: number;
  capitalAfter: number;
}

function simulateTrades(
  candles: Candle[],
  entry: RuleExpr,
  exit: RuleExpr,
  riskPct: number,
  initialCapital: number,
): TradeRecord[] {
  const closes = new Float64Array(candles.map((c) => c.close));
  const cache = new Map<string, IndicatorSeries>();
  const trades: TradeRecord[] = [];

  let capital = initialCapital;
  let inTrade = false;
  let entryIdx = 0;
  let entryPrice = 0;
  let stopDist = 0;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;
    if (!inTrade) {
      if (evalRule(entry, closes, cache, i)) {
        inTrade = true;
        entryIdx = i;
        entryPrice = candle.close;
        // Stop distance = riskPct% of entry price (1 R = riskPct% move)
        stopDist = entryPrice * (riskPct / 100);
      }
    } else if (evalRule(exit, closes, cache, i)) {
      const exitPrice = candle.close;
      const rMultiple = stopDist > 0 ? (exitPrice - entryPrice) / stopDist : 0;
      const capitalAtRisk = capital * (riskPct / 100);
      const pnl = capitalAtRisk * rMultiple;
      // Floor at 1 cent so capital never reaches exactly zero
      capital = Math.max(0.01, capital + pnl);

      trades.push({
        entryAt: candles[entryIdx]?.ts ?? "",
        exitAt: candle.ts,
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
        rMultiple: Math.round(rMultiple * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        capitalAfter: Math.round(capital * 100) / 100,
      });

      inTrade = false;
    }
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function computeStats(trades: TradeRecord[], initialCapital: number): BacktestRulesOutput["stats"] {
  if (trades.length === 0) {
    return { trades: 0, winRate: 0, profitFactor: 0, expectancyR: 0, maxDrawdownPct: 0, sharpe: 0 };
  }

  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  const winRate = winners.length / trades.length;
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999.99 : 0) : grossProfit / grossLoss;

  const rValues = trades.map((t) => t.rMultiple);
  const expectancyR = rValues.reduce((s, r) => s + r, 0) / rValues.length;

  // Max drawdown from running equity peak
  let peak = initialCapital;
  let maxDD = 0;
  for (const t of trades) {
    if (t.capitalAfter > peak) peak = t.capitalAfter;
    const dd = peak > 0 ? (peak - t.capitalAfter) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Annualised Sharpe (treats each trade as one sample; * sqrt(252) for ~daily spacing)
  const meanR = expectancyR;
  const variance = rValues.reduce((s, r) => s + (r - meanR) ** 2, 0) / rValues.length;
  const stdR = Math.sqrt(variance);
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

  return {
    trades: trades.length,
    winRate: Math.round(winRate * 1000) / 1000,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancyR: Math.round(expectancyR * 1000) / 1000,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
  };
}

function computeEquityCurve(
  trades: TradeRecord[],
  initialCapital: number,
): BacktestRulesOutput["equityCurveSummary"] {
  const values = [initialCapital, ...trades.map((t) => t.capitalAfter)];
  const startValue = initialCapital;
  const endValue = values[values.length - 1] ?? initialCapital;
  let peakValue = initialCapital;
  let troughValue = initialCapital;
  for (const v of values) {
    if (v > peakValue) peakValue = v;
    if (v < troughValue) troughValue = v;
  }

  // 12 evenly spaced return buckets (approximation of monthly returns)
  const monthlyReturns: number[] = [];
  for (let s = 0; s < 12; s++) {
    const startIdx = Math.floor((s * values.length) / 12);
    const endIdx = Math.min(Math.floor(((s + 1) * values.length) / 12), values.length - 1);
    const segStart = values[startIdx] ?? startValue;
    const segEnd = values[endIdx] ?? segStart;
    monthlyReturns.push(
      segStart > 0 ? Math.round(((segEnd - segStart) / segStart) * 10000) / 100 : 0,
    );
  }

  return {
    startValue: Math.round(startValue * 100) / 100,
    endValue: Math.round(endValue * 100) / 100,
    peakValue: Math.round(peakValue * 100) / 100,
    troughValue: Math.round(troughValue * 100) / 100,
    monthlyReturns,
  };
}

// ---------------------------------------------------------------------------
// Sample trade selection — representative subset, never the full list.
// This is the canonical truncation gate for N4: the model must not receive
// hundreds of raw trades in a single tool response.
// ---------------------------------------------------------------------------

function selectSampleTrades(
  trades: TradeRecord[],
  maxSamples: number,
): BacktestRulesOutput["sampleTrades"] {
  if (trades.length === 0) return [];

  // Strip internal capitalAfter before returning
  const strip = ({ capitalAfter: _cap, ...t }: TradeRecord) => t;

  if (trades.length <= maxSamples) return trades.map(strip);

  // Select representative trades: first, last, best (R), worst (R), median (R)
  const sorted = [...trades].sort((a, b) => b.rMultiple - a.rMultiple);
  const indices = new Set<number>();
  indices.add(0);
  indices.add(trades.length - 1);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best !== undefined) indices.add(trades.indexOf(best));
  if (worst !== undefined) indices.add(trades.indexOf(worst));
  if (indices.size < maxSamples) {
    const mid = sorted[Math.floor(sorted.length / 2)];
    if (mid !== undefined) indices.add(trades.indexOf(mid));
  }

  return [...indices]
    .sort((a, b) => a - b)
    .slice(0, maxSamples)
    .flatMap((i) => {
      const t = trades[i];
      return t !== undefined ? [strip(t)] : [];
    });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBacktestRulesTool(
  definition: ToolDefinition,
): Tool<BacktestRulesInput, BacktestRulesOutput> {
  return {
    definition,
    inputSchema: BacktestRulesInputSchema,

    async execute(input): Promise<BacktestRulesOutput> {
      const { symbol, timeframe, range, entry, exit, riskPct, initialCapital } = input;

      const candles = generateCandles(symbol, timeframe, range.from, range.to);

      if (candles.length < 2) {
        // Not enough candles to run any trades
        return {
          stats: {
            trades: 0,
            winRate: 0,
            profitFactor: 0,
            expectancyR: 0,
            maxDrawdownPct: 0,
            sharpe: 0,
          },
          sampleTrades: [],
          equityCurveSummary: {
            startValue: initialCapital,
            endValue: initialCapital,
            peakValue: initialCapital,
            troughValue: initialCapital,
            monthlyReturns: Array(12).fill(0) as number[],
          },
        };
      }

      const trades = simulateTrades(candles, entry, exit, riskPct, initialCapital);
      const stats = computeStats(trades, initialCapital);
      const equityCurveSummary = computeEquityCurve(trades, initialCapital);
      // Cap at 5 sample trades — see comment on selectSampleTrades above
      const sampleTrades = selectSampleTrades(trades, 5);

      return { stats, sampleTrades, equityCurveSummary };
    },
  };
}
