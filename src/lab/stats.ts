/**
 * Statistics for pre-registered, binary-read experiments.
 *
 * Priors are skeptical and centred on the decision floor with a weight of two
 * pseudo-observations: Beta(2*floor, 2*(1-floor)) for proportions and Gamma(0.5, 0.5/floor)
 * for rates. A flat Beta(1,1) would "pass" a rare-event metric (installs per view, floor
 * 0.0015) with zero successes because its mass sits far above the floor; a prior centred on
 * the floor makes "no data" read as "not working". Rates (e.g. K-factor) use a Poisson
 * likelihood. Traffic is clustered by source (a few creator posts drive most
 * installs), so counts are deflated to an effective sample size via a method-of-moments
 * intraclass correlation before any posterior is formed.
 */

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += (LANCZOS[i] as number) / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes betacf). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 500;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) = Beta CDF at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

export function betaQuantile(q: number, a: number, b: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Regularized lower incomplete gamma P(s, x). */
export function gammaIncLower(s: number, x: number): number {
  if (x <= 0) return 0;
  const lnFront = s * Math.log(x) - x - lnGamma(s);
  if (x < s + 1) {
    let sum = 1 / s;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(lnFront));
  }
  // Continued fraction for the upper tail (Lentz).
  const FPMIN = 1e-300;
  let b = x + 1 - s;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lnFront) * h);
}

/** CDF of Gamma(shape, rate) at x. */
export function gammaCdf(x: number, shape: number, rate: number): number {
  return gammaIncLower(shape, x * rate);
}

export function gammaQuantile(q: number, shape: number, rate: number): number {
  if (q <= 0) return 0;
  let hi = Math.max(1, (shape / rate) * 4);
  while (gammaCdf(hi, shape, rate) < q) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (gammaCdf(mid, shape, rate) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Inverse standard normal CDF (Acklam's algorithm, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const at = (arr: number[], i: number) => arr[i] as number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) * q) /
    (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
}

export function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function lnBinomPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/** P(X >= k) for X ~ Binomial(n, p). Exact for n <= 20,000, normal approximation above. */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (n > 20_000) {
    const mean = n * p;
    const sd = Math.sqrt(n * p * (1 - p));
    return 1 - normalCdf((k - 0.5 - mean) / sd);
  }
  let sum = 0;
  for (let i = k; i <= n; i++) {
    const term = Math.exp(lnBinomPmf(i, n, p));
    sum += term;
    if (i > n * p && term < 1e-16) break;
  }
  return Math.min(1, sum);
}

/** P(X >= k) for X ~ Poisson(mean). */
export function poissonUpperTail(k: number, mean: number): number {
  if (k <= 0) return 1;
  if (mean > 1_000) return 1 - normalCdf((k - 0.5 - mean) / Math.sqrt(mean));
  let cdf = 0;
  let term = Math.exp(-mean);
  for (let i = 0; i < k; i++) {
    cdf += term;
    term *= mean / (i + 1);
  }
  return Math.max(0, 1 - cdf);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export interface SourceCounts {
  successes: number;
  trials: number;
}

/**
 * Method-of-moments (ANOVA) intraclass correlation for binary outcomes grouped by source,
 * floored at 0.01. A single source gives rho = 1 (one cluster is one observation).
 */
export function intraclassCorrelation(sources: SourceCounts[]): number {
  const groups = sources.filter((s) => s.trials > 0);
  const k = groups.length;
  const N = groups.reduce((s, g) => s + g.trials, 0);
  if (k < 2 || N - k <= 0) return 1;
  const pBar = groups.reduce((s, g) => s + g.successes, 0) / N;
  let ssb = 0;
  let ssw = 0;
  for (const g of groups) {
    const p = g.successes / g.trials;
    ssb += g.trials * (p - pBar) ** 2;
    ssw += g.trials * p * (1 - p);
  }
  const msb = ssb / (k - 1);
  const msw = ssw / (N - k);
  const n0 = (N - groups.reduce((s, g) => s + g.trials ** 2, 0) / N) / (k - 1);
  const denom = msb + (n0 - 1) * msw;
  if (denom <= 0) return 0.01;
  return Math.min(1, Math.max(0.01, (msb - msw) / denom));
}

export interface EffectiveCounts {
  successes: number;
  trials: number;
  designEffect: number;
  rho: number;
}

/**
 * Deflate clustered counts: nEff = n / (1 + (m - 1) * rho), where m is the size-weighted
 * mean cluster size. Successes scale by the same factor.
 */
export function effectiveCounts(total: SourceCounts, bySource: Record<string, SourceCounts>): EffectiveCounts {
  const groups = Object.values(bySource).filter((g) => g.trials > 0);
  if (total.trials <= 0) return { successes: 0, trials: 0, designEffect: 1, rho: 0 };
  if (groups.length === 0) return { ...total, designEffect: 1, rho: 0 };
  const rho = intraclassCorrelation(groups);
  const N = groups.reduce((s, g) => s + g.trials, 0);
  const mBar = groups.reduce((s, g) => s + g.trials ** 2, 0) / N;
  const designEffect = Math.max(1, 1 + (mBar - 1) * rho);
  return { successes: total.successes / designEffect, trials: total.trials / designEffect, designEffect, rho };
}

// ---------------------------------------------------------------------------
// Posteriors
// ---------------------------------------------------------------------------

export type Posterior = { kind: "proportion"; a: number; b: number } | { kind: "rate"; shape: number; rate: number };

/** Pseudo-observations behind the skeptical prior. */
export const PRIOR_WEIGHT = 2;

function priorCentre(priorMean: number): number {
  return Math.min(0.999, Math.max(1e-6, priorMean));
}

/** Beta posterior with a skeptical prior centred on `priorMean` (normally the metric floor). */
export function proportionPosterior(successes: number, trials: number, priorMean: number): Posterior {
  const s = Math.max(0, Math.min(successes, trials));
  const m = priorCentre(priorMean);
  return { kind: "proportion", a: PRIOR_WEIGHT * m + s, b: PRIOR_WEIGHT * (1 - m) + Math.max(0, trials - s) };
}

/** Gamma posterior for events per exposure unit with a prior centred on `priorMean`. */
export function ratePosterior(events: number, exposure: number, priorMean: number): Posterior {
  const m = Math.max(1e-6, priorMean);
  return { kind: "rate", shape: 0.5 + Math.max(0, events), rate: 0.5 / m + Math.max(0, exposure) };
}

export function posteriorMean(p: Posterior): number {
  return p.kind === "proportion" ? p.a / (p.a + p.b) : p.shape / p.rate;
}

/** P(true value >= x). */
export function probAtLeast(p: Posterior, x: number): number {
  return p.kind === "proportion" ? 1 - betaCdf(x, p.a, p.b) : 1 - gammaCdf(x, p.shape, p.rate);
}

/** P(true value < x). */
export function probBelow(p: Posterior, x: number): number {
  return 1 - probAtLeast(p, x);
}

export function quantile(p: Posterior, q: number): number {
  return p.kind === "proportion" ? betaQuantile(q, p.a, p.b) : gammaQuantile(q, p.shape, p.rate);
}

/** Central interval of mass `mass`. */
export function credibleInterval(p: Posterior, mass: number): [number, number] {
  const tail = (1 - mass) / 2;
  return [quantile(p, tail), quantile(p, 1 - tail)];
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export interface PowerResult {
  /** Per-cell sample in denominator units (before any design effect). */
  n: number;
  powerAtTarget: number;
  falsePassAtFloor: number;
}

/** Smallest success count that passes a proportion cell of size n (n + 1 if none can). */
export function passThresholdCount(n: number, floor: number, confidence: number): number {
  const passes = (k: number) => probAtLeast(proportionPosterior(k, n, floor), floor) >= confidence;
  if (!passes(n)) return n + 1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Smallest event count that passes a rate cell with this exposure. */
export function passThresholdEvents(exposure: number, floor: number, confidence: number): number {
  const passes = (k: number) => probAtLeast(ratePosterior(k, exposure, floor), floor) >= confidence;
  let hi = Math.max(10, Math.ceil(floor * exposure * 4 + 50));
  while (!passes(hi)) hi *= 2;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function cellPassProb(kind: "proportion" | "rate", n: number, p: number, floor: number, confidence: number): number {
  if (kind === "proportion") return binomialUpperTail(passThresholdCount(n, floor, confidence), n, p);
  return poissonUpperTail(passThresholdEvents(n, floor, confidence), p * n);
}

/**
 * Exact power search: the smallest per-cell n at which ALL `cells` pass with probability
 * >= power when the true value equals `target` (pass = P(p >= floor) >= confidence).
 */
export function requiredSamplePerCell(opts: {
  kind: "proportion" | "rate";
  floor: number;
  target: number;
  cells: number;
  confidence: number;
  power: number;
  maxN?: number;
}): PowerResult {
  const { kind, floor, target, cells, confidence, power } = opts;
  const maxN = opts.maxN ?? 50_000_000;
  if (target <= floor) throw new Error(`target (${target}) must exceed floor (${floor})`);
  const powerAt = (n: number) => cellPassProb(kind, n, target, floor, confidence) ** cells;
  let hi = 8;
  while (powerAt(hi) < power) {
    hi *= 2;
    if (hi > maxN) return { n: maxN, powerAtTarget: powerAt(maxN), falsePassAtFloor: cellPassProb(kind, maxN, floor, floor, confidence) ** cells };
  }
  let lo = Math.floor(hi / 2);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (powerAt(mid) >= power) hi = mid;
    else lo = mid + 1;
  }
  return { n: lo, powerAtTarget: powerAt(lo), falsePassAtFloor: cellPassProb(kind, lo, floor, floor, confidence) ** cells };
}
