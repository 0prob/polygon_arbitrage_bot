/**
 * Brent's method for finding the maximum of a 1D function over a BigInt range [a, b].
 * This is a derivative-free optimization method that combines golden section search
 * and successive parabolic interpolation.
 */
export function solveBrentOptimal(low: bigint, high: bigint, evaluate: (amount: bigint) => bigint, maxIterations: number = 8): bigint {
  if (low >= high) return low;

  const cache = new Map<bigint, bigint>();
  const cachedEvaluate = (amount: bigint): bigint => {
    let cached = cache.get(amount);
    if (cached === undefined) {
      cached = evaluate(amount);
      cache.set(amount, cached);
    }
    return cached;
  };

  const goldenRatio = 382n; // (3 - sqrt(5))/2 * 1000 approx 382
  const CONVERGENCE_DIVISOR = 1000n; // Stop if interval is less than 0.1% of high

  let a = low;
  let b = high;

  // x is the point with the largest function value found so far
  // w is the point with the second largest function value
  // v is the previous value of w
  let x = a + (b - a) / 2n;
  let w = x;
  let v = x;

  let fx = cachedEvaluate(x);
  let fw = fx;
  let fv = fx;

  let d = 0n;
  let e = 0n; // Distance moved on step before last

  for (let iter = 0; iter < maxIterations; iter++) {
    const xm = a + (b - a) / 2n;
    const tol = high / CONVERGENCE_DIVISOR > 1n ? high / CONVERGENCE_DIVISOR : 1n;

    // Check if the current interval size is smaller than the tolerance
    if (b - a <= tol) {
      break;
    }

    let p = 0n;
    let q = 0n;

    // Try parabolic fit if e (step before last) is large enough
    if (e > tol) {
      // Fit parabola
      const tmp1 = (x - w) * (fx - fv);
      const tmp2 = (x - v) * (fx - fw);
      p = (x - v) * tmp2 - (x - w) * tmp1;
      q = 2n * (tmp2 - tmp1);

      if (q > 0n) {
        p = -p;
      } else {
        q = -q;
      }

      // Check if parabolic step is acceptable
      // i.e., it must be within [a, b] and the step size must be less than half of the step before last
      if (q > 0n && p > q * (a - x) && p < q * (b - x) && (p < 0n ? -p : p) < (q * e) / 2n) {
        e = d;
        d = p / q;
      } else {
        // Fall back to golden section
        e = x >= xm ? a - x : b - x;
        d = (e * goldenRatio) / 1000n;
      }
    } else {
      // Golden section step
      e = x >= xm ? a - x : b - x;
      d = (e * goldenRatio) / 1000n;
    }

    // u is the next evaluation point
    let u = x + d;
    // Don't evaluate too close to the boundaries
    if (u - a < tol) {
      u = a + tol;
    } else if (b - u < tol) {
      u = b - tol;
    }

    // Clamp u to [low, high]
    if (u < low) u = low;
    if (u > high) u = high;

    const fu = cachedEvaluate(u);

    if (fu >= fx) {
      if (u >= x) {
        a = x;
      } else {
        b = x;
      }
      v = w;
      fv = fw;
      w = x;
      fw = fx;
      x = u;
      fx = fu;
    } else {
      if (u < x) {
        a = u;
      } else {
        b = u;
      }
      if (fu >= fw || w === x) {
        v = w;
        fv = fw;
        w = u;
        fw = fu;
      } else if (fu >= fv || v === x || v === w) {
        v = u;
        fv = fu;
      }
    }
  }

  // Compare final result against exact boundaries to support boundary maxima
  const flow = cachedEvaluate(low);
  const fhigh = cachedEvaluate(high);
  if (flow > fx && flow >= fhigh) {
    return low;
  }
  if (fhigh > fx && fhigh > flow) {
    return high;
  }

  return x;
}
