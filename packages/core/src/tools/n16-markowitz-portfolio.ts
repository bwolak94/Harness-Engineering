import type { ToolDefinition } from "@harness/contracts";
import {
  type EfficientFrontierPoint,
  type MarkowitzPortfolioInput,
  MarkowitzPortfolioInputSchema,
  type MarkowitzPortfolioOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

/** Immutable numeric vector. */
type Vec = readonly number[];
/** Immutable numeric matrix (row-major). */
type Mat = readonly Vec[];

// ---------------------------------------------------------------------------
// Linear algebra primitives
// ---------------------------------------------------------------------------

/** Dot product of two equal-length vectors. */
function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Matrix–vector product: result[i] = Σ_j A[i][j] * v[j]. */
function matVec(A: Mat, v: Vec): number[] {
  return A.map((row) => dot(row, v));
}

/**
 * Solve the linear system Ax = b using Gauss–Jordan elimination with partial
 * pivoting. Operates on a copy of the inputs; the originals are not mutated.
 *
 * @throws {Error} when the matrix is singular or nearly singular (|pivot| < 1e-12).
 */
function solveLinear(A: Mat, b: Vec): number[] {
  const n = A.length;
  // Build a mutable augmented matrix [A | b].
  const aug: number[][] = A.map((row, i) => [...row, b[i] ?? 0]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting: swap in the row with the largest absolute value in this column.
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row]?.[col] ?? 0) > Math.abs(aug[pivotRow]?.[col] ?? 0)) {
        pivotRow = row;
      }
    }
    // col and pivotRow are always in [0, n-1]; the ?? [] fallback is unreachable.
    const rowA = aug[col] ?? [];
    const rowB = aug[pivotRow] ?? [];
    aug[col] = rowB;
    aug[pivotRow] = rowA;

    const pivot = aug[col]?.[col] ?? 0;
    if (Math.abs(pivot) < 1e-12) {
      throw new Error(
        `Covariance matrix is singular at column ${col}. Ensure all assets have positive variance and that no two assets are perfectly correlated.`,
      );
    }

    // Eliminate all other rows (Gauss–Jordan: reduces to diagonal form).
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = (aug[row]?.[col] ?? 0) / pivot;
      for (let k = col; k <= n; k++) {
        (aug[row] as number[])[k] = (aug[row]?.[k] ?? 0) - factor * (aug[col]?.[k] ?? 0);
      }
    }
  }

  // After Gauss–Jordan, [A | b] → [D | x*D] where D is diagonal.
  // Solution: x[i] = aug[i][n] / aug[i][i].
  return aug.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

// ---------------------------------------------------------------------------
// Portfolio metrics
// ---------------------------------------------------------------------------

/** Expected portfolio return: w^T μ. */
function pReturn(w: Vec, mu: Vec): number {
  return dot(w, mu);
}

/** Portfolio variance: w^T Σ w. Clamped to 0 to avoid numerical negatives. */
function pVariance(w: Vec, cov: Mat): number {
  return Math.max(0, dot(w, matVec(cov, w)));
}

/** Portfolio standard deviation: sqrt(w^T Σ w). */
function pStdDev(w: Vec, cov: Mat): number {
  return Math.sqrt(pVariance(w, cov));
}

/**
 * Sharpe ratio: (R_p - rf) / σ_p.
 * Returns 0 when σ_p < 1e-10 (degenerate / cash-only portfolio).
 */
function pSharpe(w: Vec, mu: Vec, cov: Mat, rf: number): number {
  const sigma = pStdDev(w, cov);
  return sigma < 1e-10 ? 0 : (pReturn(w, mu) - rf) / sigma;
}

// ---------------------------------------------------------------------------
// Probability simplex projection
//
// Computes w* = argmin_{w: w≥0, Σw=1} ||w − v||²
// Algorithm: Duchi, Shalev-Shwartz, Singer, Chandra (2008), O(n log n).
// ---------------------------------------------------------------------------

function projectSimplex(v: Vec): number[] {
  const n = v.length;
  const sorted = [...v].sort((a, b) => b - a);

  let cumSum = 0;
  let rho = 0;
  for (let j = 0; j < n; j++) {
    cumSum += sorted[j] ?? 0;
    // Track the largest j satisfying: sorted[j] > (cumSum - 1) / (j + 1)
    if ((sorted[j] ?? 0) * (j + 1) > cumSum - 1) rho = j;
  }

  // Re-compute cumSum up to rho for the threshold.
  const cumRho = sorted.slice(0, rho + 1).reduce((s, x) => s + x, 0);
  const theta = (cumRho - 1) / (rho + 1);
  return v.map((x) => Math.max(x - theta, 0));
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInputs(
  assets: MarkowitzPortfolioInput["assets"],
  cov: MarkowitzPortfolioInput["covarianceMatrix"],
): void {
  const n = assets.length;

  if (cov.length !== n) {
    throw new Error(
      `covarianceMatrix must have ${n} rows (one per asset) but has ${cov.length} rows.`,
    );
  }

  for (let i = 0; i < n; i++) {
    const row = cov[i];
    if (!row || row.length !== n) {
      throw new Error(
        `covarianceMatrix row ${i} must have ${n} columns but has ${row?.length ?? 0}.`,
      );
    }

    const variance = row[i] ?? 0;
    if (variance <= 0) {
      throw new Error(
        `Asset '${assets[i]?.name}' has non-positive variance (${variance}) at ` +
          `covarianceMatrix[${i}][${i}]. Every asset must have positive variance (stdDev² > 0).`,
      );
    }

    // Approximate symmetry check (relative tolerance 1e-6).
    for (let j = i + 1; j < n; j++) {
      const ij = cov[i]?.[j] ?? 0;
      const ji = cov[j]?.[i] ?? 0;
      const scale = Math.max(1, Math.abs(ij), Math.abs(ji));
      if (Math.abs(ij - ji) > 1e-6 * scale) {
        throw new Error(
          `covarianceMatrix is not symmetric: cov[${i}][${j}]=${ij} ≠ cov[${j}][${i}]=${ji}. Ensure the matrix equals its transpose.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Analytical optimizers (exact closed-form, used when allowShortSelling=true)
// ---------------------------------------------------------------------------

/**
 * Compute the global minimum-variance portfolio analytically.
 * Solves Σ w = 1 (w ∝ Σ^{-1}·1), then normalizes to sum = 1.
 */
function analyticalMinVar(cov: Mat): number[] {
  const n = cov.length;
  const ones: number[] = Array<number>(n).fill(1);
  const raw = solveLinear(cov, ones);
  const total = raw.reduce((s, x) => s + x, 0);
  // If the sum is near-zero (numerically pathological), fall back to equal weights.
  return Math.abs(total) > 1e-12 ? raw.map((x) => x / total) : ones.map(() => 1 / n);
}

/**
 * Compute the tangency (maximum Sharpe) portfolio analytically.
 * Solves Σ w = (μ − rf·1) (w ∝ Σ^{-1}·(μ − rf·1)), then normalizes.
 *
 * Returns null when the risk-free rate exceeds all asset expected returns (no
 * positive excess return exists, so the tangency portfolio is undefined).
 */
function analyticalTangency(mu: Vec, cov: Mat, rf: number): number[] | null {
  const excess = mu.map((m) => m - rf);
  if (excess.every((e) => e <= 0)) return null;

  const raw = solveLinear(cov, excess);
  const total = raw.reduce((s, x) => s + x, 0);
  return Math.abs(total) > 1e-12 ? raw.map((x) => x / total) : null;
}

// ---------------------------------------------------------------------------
// Numerical optimizers (projected gradient descent, used for long-only)
// ---------------------------------------------------------------------------

/**
 * Compute a safe step size for gradient descent on portfolio variance.
 * Uses the Frobenius norm of Σ as an upper bound on 2·λ_max(Σ).
 */
function safeVarianceLR(cov: Mat): number {
  let frobSq = 0;
  for (const row of cov) for (const x of row) frobSq += x * x;
  // Convergence requires lr ≤ 1 / (2·λ_max(Σ)) ≤ 1 / (2·||Σ||_F).
  return 1 / (2 * Math.sqrt(frobSq) + 1e-8);
}

/**
 * Minimize portfolio variance via projected gradient descent on the simplex.
 *
 * Converges to the global minimum-variance portfolio when w0 is on the simplex
 * and the step size satisfies lr ≤ 1/(2·λ_max(Σ)).
 */
function numericalMinVar(cov: Mat, w0: Vec, maxIter = 1500): number[] {
  const lr = safeVarianceLR(cov);
  let w = [...w0];

  for (let iter = 0; iter < maxIter; iter++) {
    // Gradient of variance w.r.t. w: ∇(w^T Σ w) = 2Σw.
    const grad = matVec(cov, w).map((x) => 2 * x);
    w = projectSimplex(w.map((x, i) => x - lr * (grad[i] ?? 0)));
  }

  return w;
}

/**
 * Maximize the Sharpe ratio via projected gradient ascent on the simplex.
 *
 * ∇_w Sharpe = [(μ_i·σ² − (R·(Σw)_i)] / σ³
 * where R = w·μ − rf and σ = pStdDev(w, cov).
 *
 * Steps are clipped so no single weight changes by more than MAX_WEIGHT_STEP
 * per iteration, ensuring stability across covariance scales.
 */
function numericalMaxSharpe(mu: Vec, cov: Mat, rf: number, w0: Vec, maxIter = 1500): number[] {
  const MAX_WEIGHT_STEP = 0.02;
  let w = [...w0];

  for (let iter = 0; iter < maxIter; iter++) {
    const sigma = pStdDev(w, cov);
    if (sigma < 1e-12) break;

    const ret = pReturn(w, mu);
    const excessRet = ret - rf;
    const sigmaSq = sigma * sigma;
    const sigmaCubed = sigma * sigmaSq;

    const covW = matVec(cov, w);
    // ∇S[i] = (μ[i]·σ² − excessRet·(Σw)[i]) / σ³
    const gradSharpe = mu.map(
      (m, i) => ((m - rf) * sigmaSq - excessRet * (covW[i] ?? 0)) / sigmaCubed,
    );

    // Clip the step to avoid overshooting.
    const gradNorm = Math.sqrt(gradSharpe.reduce((s, g) => s + g * g, 0));
    const lr = gradNorm > 0 ? Math.min(MAX_WEIGHT_STEP / gradNorm, 0.1 / (1 + iter * 0.001)) : 0;

    w = projectSimplex(w.map((x, i) => x + lr * (gradSharpe[i] ?? 0)));
  }

  return w;
}

// ---------------------------------------------------------------------------
// Portfolio selectors (dispatch between analytical and numerical paths)
// ---------------------------------------------------------------------------

/**
 * Global minimum-variance portfolio.
 *   allowShortSelling=true  → analytical (Σ^{-1}·1, normalized).
 *   allowShortSelling=false → numerical projected gradient descent.
 */
function globalMinVariance(mu: Vec, cov: Mat, allowShortSelling: boolean): number[] {
  if (allowShortSelling) return analyticalMinVar(cov);
  const n = mu.length;
  const equalW: number[] = Array<number>(n).fill(1 / n);
  return numericalMinVar(cov, equalW);
}

/**
 * Tangency (maximum Sharpe ratio) portfolio.
 *   allowShortSelling=true  → analytical (Σ^{-1}·(μ−rf·1), normalized).
 *   allowShortSelling=false → numerical projected gradient ascent, initialized
 *                             from the clipped analytical solution for speed.
 *
 * Falls back to the global min-variance portfolio when no positive excess
 * return exists (rf ≥ all μ_i).
 */
function tangencyPortfolio(mu: Vec, cov: Mat, rf: number, allowShortSelling: boolean): number[] {
  if (allowShortSelling) {
    const w = analyticalTangency(mu, cov, rf);
    return w ?? analyticalMinVar(cov);
  }

  // Long-only: start from the clipped analytical solution as a warm start.
  const analytical = analyticalTangency(mu, cov, rf);
  const n = mu.length;
  const w0: number[] = analytical
    ? projectSimplex(analytical.map((x) => Math.max(x, 0)))
    : (Array<number>(n).fill(1 / n) as number[]);

  return numericalMaxSharpe(mu, cov, rf, w0);
}

// ---------------------------------------------------------------------------
// Efficient frontier
// ---------------------------------------------------------------------------

/**
 * Build the efficient frontier as `numPoints` portfolios traced from the
 * global minimum-variance portfolio to the maximum single-asset return.
 *
 * For the unconstrained case the two-fund separation theorem guarantees that
 * the parametric blend w(α) = (1−α)·wMin + α·wMaxRet is a subset of the
 * frontier. For the long-only case this is also on the frontier because both
 * endpoints are corner portfolios of the long-only efficient set.
 */
function buildEfficientFrontier(
  mu: Vec,
  cov: Mat,
  rf: number,
  allowShortSelling: boolean,
  numPoints: number,
): EfficientFrontierPoint[] {
  const minVarW = globalMinVariance(mu, cov, allowShortSelling);
  const minRet = pReturn(minVarW, mu);
  const maxRetIdx = mu.reduce(
    (best, r, i) => (r > (mu[best] ?? Number.NEGATIVE_INFINITY) ? i : best),
    0,
  );
  const maxRet = mu[maxRetIdx] ?? 0;
  const n = mu.length;

  // Maximum-return portfolio: 100% in the highest-return asset.
  const maxRetW: number[] = Array<number>(n).fill(0);
  maxRetW[maxRetIdx] = 1;

  const range = maxRet - minRet;

  return Array.from({ length: numPoints }, (_, i) => {
    const alpha = numPoints > 1 ? i / (numPoints - 1) : 0;
    const w: number[] =
      range < 1e-12
        ? [...minVarW]
        : minVarW.map((x, j) => (1 - alpha) * x + alpha * (maxRetW[j] ?? 0));

    return {
      volatility: pStdDev(w, cov),
      expectedReturn: pReturn(w, mu),
      sharpeRatio: pSharpe(w, mu, cov, rf),
    };
  });
}

/**
 * Binary-search for the efficient portfolio whose volatility is closest to
 * `targetVol`. Searches along the parametric blend from min-variance to
 * max-return, which is monotone in volatility for typical asset sets.
 *
 * Returns the min-variance portfolio when targetVol is below the minimum
 * achievable volatility, and the max-return portfolio when above.
 */
function portfolioAtTargetVol(
  mu: Vec,
  cov: Mat,
  allowShortSelling: boolean,
  targetVol: number,
  assumptions: string[],
): number[] {
  const n = mu.length;
  const minVarW = globalMinVariance(mu, cov, allowShortSelling);
  const minVol = pStdDev(minVarW, cov);

  const maxRetIdx = mu.reduce(
    (best, r, i) => (r > (mu[best] ?? Number.NEGATIVE_INFINITY) ? i : best),
    0,
  );
  const maxRetW: number[] = Array<number>(n).fill(0);
  maxRetW[maxRetIdx] = 1;
  const maxVol = pStdDev(maxRetW, cov);

  if (targetVol <= minVol) {
    assumptions.push(
      `Target volatility ${(targetVol * 100).toFixed(2)}% is below the global minimum ` +
        `(${(minVol * 100).toFixed(2)}%). Using global minimum-variance portfolio.`,
    );
    return minVarW;
  }

  if (targetVol >= maxVol) {
    assumptions.push(
      `Target volatility ${(targetVol * 100).toFixed(2)}% exceeds the maximum single-asset ` +
        `volatility (${(maxVol * 100).toFixed(2)}%). Using maximum-return portfolio.`,
    );
    return maxRetW;
  }

  // Binary search on the blend parameter α ∈ [0, 1].
  let lo = 0;
  let hi = 1;
  let bestW: number[] = [...minVarW];

  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const w = minVarW.map((x, j) => (1 - mid) * x + mid * (maxRetW[j] ?? 0));
    const vol = pStdDev(w, cov);
    bestW = w;
    if (Math.abs(vol - targetVol) < 1e-9) break;
    if (vol < targetVol) lo = mid;
    else hi = mid;
  }

  assumptions.push(
    `Binary search converged: volatility ≈ ${(pStdDev(bestW, cov) * 100).toFixed(2)}%, ` +
      `return ≈ ${(pReturn(bestW, mu) * 100).toFixed(2)}%`,
  );
  return bestW;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMarkowitzPortfolioTool(
  definition: ToolDefinition,
): Tool<MarkowitzPortfolioInput, MarkowitzPortfolioOutput> {
  return {
    definition,
    inputSchema: MarkowitzPortfolioInputSchema,

    async execute(input) {
      const { assets, covarianceMatrix, riskFreeRate, targetVolatility, allowShortSelling } = input;
      const assumptions: string[] = [];

      validateInputs(assets, covarianceMatrix);

      const mu: Vec = assets.map((a) => a.expectedReturn);
      const cov: Mat = covarianceMatrix;
      const n = assets.length;

      assumptions.push(
        `Assets: ${assets.map((a) => a.name).join(", ")} (n=${n})`,
        `Mode: ${allowShortSelling ? "unconstrained (short-selling allowed)" : "long-only (weights ≥ 0)"}`,
        `Risk-free rate: ${(riskFreeRate * 100).toFixed(2)}%`,
      );

      // ── Select the optimal portfolio ────────────────────────────────────────
      let optW: number[];

      if (targetVolatility !== undefined) {
        assumptions.push(
          `Objective: minimum variance at target volatility ${(targetVolatility * 100).toFixed(2)}%`,
        );
        optW = portfolioAtTargetVol(mu, cov, allowShortSelling, targetVolatility, assumptions);
      } else {
        assumptions.push("Objective: maximize Sharpe ratio (tangency portfolio)");
        optW = tangencyPortfolio(mu, cov, riskFreeRate, allowShortSelling);
      }

      // ── Compute output metrics ───────────────────────────────────────────────
      const portReturn = pReturn(optW, mu);
      const portVol = pStdDev(optW, cov);
      const portSharpe = pSharpe(optW, mu, cov, riskFreeRate);

      assumptions.push(
        `Result: return=${(portReturn * 100).toFixed(2)}%, ` +
          `volatility=${(portVol * 100).toFixed(2)}%, ` +
          `Sharpe=${portSharpe.toFixed(4)}`,
      );

      // ── Build weights record ─────────────────────────────────────────────────
      const weights: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        weights[assets[i]?.name ?? `asset_${i}`] = Number((optW[i] ?? 0).toFixed(8));
      }

      // ── Efficient frontier ──────────────────────────────────────────────────
      const efficientFrontierPoints = buildEfficientFrontier(
        mu,
        cov,
        riskFreeRate,
        allowShortSelling,
        21,
      );

      return {
        weights,
        portfolioReturn: portReturn,
        portfolioVolatility: portVol,
        sharpeRatio: portSharpe,
        efficientFrontierPoints,
        assumptions,
      };
    },
  };
}
