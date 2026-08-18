// ---------------------------------------------------------------------------
// CostForecaster — proactive budget forecasting via double exponential smoothing
//
// Implements Holt's linear trend method (also called double exponential smoothing).
// Pure computation — no I/O, no external dependencies.
//
// Holt's method (additive trend):
//   Level:   l[t] = α·y[t] + (1−α)·(l[t−1] + b[t−1])
//   Trend:   b[t] = β·(l[t] − l[t−1]) + (1−β)·b[t−1]
//   Forecast: ŷ[t+h] = l[t] + h·b[t]
//
// Unlike simple exponential smoothing, Holt's method captures linear trends
// in time-series data, making it well-suited for cost curves that grow or
// shrink consistently over time.
// ---------------------------------------------------------------------------

export interface DayStat {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Cost in USD for this day. */
  costUsd: number;
}

export interface ForecastPoint {
  /** ISO date string (YYYY-MM-DD) for the forecasted day. */
  date: string;
  /** Point estimate of cost in USD. Never negative (clamped to 0). */
  costUsd: number;
  /** Lower bound of the 80% prediction interval. */
  lower: number;
  /** Upper bound of the 80% prediction interval. */
  upper: number;
}

export interface ForecastResult {
  /** 7-day-ahead forecast points, one per day. */
  next7: readonly ForecastPoint[];
  /** 30-day-ahead forecast points, one per day. */
  next30: readonly ForecastPoint[];
  /** Summed projected spend over the next 30 days (USD). */
  projection30dUsd: number;
  /**
   * True when `projection30dUsd` exceeds the configured `monthlyCap`.
   * Always false if `monthlyCap` is not provided.
   */
  alert: boolean;
  /** Smoothed level at the end of the training window. */
  level: number;
  /** Smoothed trend (USD per day) at the end of the training window. */
  trend: number;
  /** Residual standard deviation used to build prediction intervals. */
  residualStd: number;
}

export interface CostForecasterConfig {
  /**
   * Level smoothing factor in (0, 1).
   * High α → reacts quickly to recent data.
   * Default: 0.3
   */
  alpha?: number;
  /**
   * Trend smoothing factor in (0, 1).
   * High β → trend reacts quickly to level changes.
   * Default: 0.1
   */
  beta?: number;
  /**
   * Monthly spend cap in USD. When the 30-day projection exceeds this,
   * `ForecastResult.alert` is set to true.
   * Omit to disable alerting.
   */
  monthlyCap?: number;
}

const DEFAULT_ALPHA = 0.3;
const DEFAULT_BETA = 0.1;

// ---------------------------------------------------------------------------
// addDays — pure date arithmetic without Date.now() (deterministic in tests)
// ---------------------------------------------------------------------------

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// computeForecast — stateless forecast from a DayStat array
// ---------------------------------------------------------------------------

/**
 * Compute a Holt's linear exponential smoothing forecast.
 *
 * @param history - Historical daily cost observations, in chronological order.
 *   Must have at least 2 entries; fewer than 2 → throws.
 * @param horizonDays - Number of days to forecast ahead (e.g. 30).
 * @param config - Smoothing parameters and optional monthly cap.
 * @returns ForecastResult with point estimates and 80% prediction intervals.
 */
export function computeForecast(
  history: readonly DayStat[],
  horizonDays: number,
  config: CostForecasterConfig = {},
): ForecastResult {
  if (history.length < 2) {
    throw new Error(`CostForecaster requires at least 2 data points, got ${history.length}.`);
  }
  if (horizonDays < 1 || !Number.isInteger(horizonDays)) {
    throw new Error(`horizonDays must be a positive integer, got ${horizonDays}.`);
  }

  const alpha = config.alpha ?? DEFAULT_ALPHA;
  const beta = config.beta ?? DEFAULT_BETA;

  if (alpha <= 0 || alpha >= 1) throw new Error(`alpha must be in (0,1), got ${alpha}.`);
  if (beta <= 0 || beta >= 1) throw new Error(`beta must be in (0,1), got ${beta}.`);

  const values = history.map((d) => d.costUsd);

  // Initialise: level = first observation, trend = mean of first-differences
  let level = values[0] ?? 0;
  let trend =
    values.length >= 2
      ? values.reduce((s, v, i) => (i === 0 ? s : s + (v - (values[i - 1] ?? 0))), 0) /
        (values.length - 1)
      : 0;

  // One-step-ahead residuals for building prediction intervals
  const residuals: number[] = [];

  for (let t = 1; t < values.length; t++) {
    const y = values[t] ?? 0;
    const prevLevel = level;
    const prevTrend = trend;

    const oneStepForecast = prevLevel + prevTrend;
    residuals.push(y - oneStepForecast);

    level = alpha * y + (1 - alpha) * (prevLevel + prevTrend);
    trend = beta * (level - prevLevel) + (1 - beta) * prevTrend;
  }

  // Residual standard deviation (sample std dev)
  const residualStd = (() => {
    if (residuals.length < 2) return 0;
    const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    const variance = residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / (residuals.length - 1);
    return Math.sqrt(variance);
  })();

  // 80% prediction interval z-factor ≈ 1.28
  const Z_80 = 1.28;

  const lastDate = history[history.length - 1]?.date ?? "";
  const forecastPoints: ForecastPoint[] = [];

  for (let h = 1; h <= horizonDays; h++) {
    const pointEstimate = level + h * trend;
    // Prediction interval widens with horizon: std ≈ residualStd * sqrt(h)
    const halfWidth = Z_80 * residualStd * Math.sqrt(h);
    const lower = Math.max(0, pointEstimate - halfWidth);
    const upper = Math.max(0, pointEstimate + halfWidth);

    forecastPoints.push({
      date: addDays(lastDate, h),
      costUsd: Math.max(0, pointEstimate),
      lower,
      upper,
    });
  }

  const next7 = forecastPoints.slice(0, 7);
  const next30 = forecastPoints.slice(0, 30);
  const projection30dUsd = next30.reduce((s, p) => s + p.costUsd, 0);
  const alert = config.monthlyCap !== undefined ? projection30dUsd > config.monthlyCap : false;

  return { next7, next30, level, trend, residualStd, projection30dUsd, alert };
}

// ---------------------------------------------------------------------------
// CostForecaster — class wrapper (dependency-injectable in composition root)
// ---------------------------------------------------------------------------

export class CostForecaster {
  constructor(private readonly config: CostForecasterConfig = {}) {}

  /**
   * Generate a 30-day forecast from historical daily cost data.
   * Delegates to the stateless `computeForecast` function.
   */
  forecast(history: readonly DayStat[]): ForecastResult {
    return computeForecast(history, 30, this.config);
  }
}
