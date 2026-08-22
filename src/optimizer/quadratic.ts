export interface QuadraticFit {
  a: number;
  b: number;
  c: number;
  vertexX: number | null;
  residualStandardDeviation: number | null;
  standardErrorA: number | null;
  standardErrorB: number | null;
  vertexStandardError: number | null;
}

interface FitPoint {
  x: number;
  y: number;
  weight: number;
}

type Mat3 = number[][];

function invert3(m: Mat3): Mat3 | null {
  const a00 = m[0]![0]!, a01 = m[0]![1]!, a02 = m[0]![2]!;
  const a10 = m[1]![0]!, a11 = m[1]![1]!, a12 = m[1]![2]!;
  const a20 = m[2]![0]!, a21 = m[2]![1]!, a22 = m[2]![2]!;
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  return [
    [
      (a11 * a22 - a12 * a21) / det,
      (a02 * a21 - a01 * a22) / det,
      (a01 * a12 - a02 * a11) / det,
    ],
    [
      (a12 * a20 - a10 * a22) / det,
      (a00 * a22 - a02 * a20) / det,
      (a02 * a10 - a00 * a12) / det,
    ],
    [
      (a10 * a21 - a11 * a20) / det,
      (a01 * a20 - a00 * a21) / det,
      (a00 * a11 - a01 * a10) / det,
    ],
  ];
}

export function fitQuadraticWeighted(points: readonly FitPoint[]): QuadraticFit | null {
  if (points.length < 3) return null;

  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (const p of points) {
    const w = p.weight > 0 && Number.isFinite(p.weight) ? p.weight : 0;
    const { x, y } = p;
    const x2 = x * x;
    s0 += w;
    s1 += w * x;
    s2 += w * x2;
    s3 += w * x2 * x;
    s4 += w * x2 * x2;
    t0 += w * y;
    t1 += w * x * y;
    t2 += w * x2 * y;
  }
  if (s0 <= 0 || s2 <= 0) return null;

  const ridge = 1e-9;
  const M: Mat3 = [
    [s4, s3, s2],
    [s3, s2 + ridge, s1],
    [s2, s1, s0],
  ];
  const inv = invert3(M);
  if (!inv) return null;
  const theta = [
    inv[0]![0]! * t2 + inv[0]![1]! * t1 + inv[0]![2]! * t0,
    inv[1]![0]! * t2 + inv[1]![1]! * t1 + inv[1]![2]! * t0,
    inv[2]![0]! * t2 + inv[2]![1]! * t1 + inv[2]![2]! * t0,
  ];
  if (!theta.every(Number.isFinite)) return null;
  const [a, b, c] = theta as [number, number, number];

  let rss = 0;
  let weightTotal = 0;
  for (const p of points) {
    const predicted = a * p.x * p.x + b * p.x + c;
    rss += Math.max(p.weight, 0) * (p.y - predicted) ** 2;
    weightTotal += Math.max(p.weight, 0);
  }
  void weightTotal;
  const effectiveDof =
    weightTotal > 0
      ? Math.max(points.length - 3, 1)
      : points.length;
  const residualVariance = rss > 0 && points.length > 3 ? rss / effectiveDof : null;

  let standardErrorA: number | null = null;
  let standardErrorB: number | null = null;
  let vertexStandardError: number | null = null;

  if (residualVariance !== null && Number.isFinite(residualVariance)) {
    standardErrorA = Math.sqrt(Math.max(inv[0]![0]! * residualVariance, 0));
    standardErrorB = Math.sqrt(Math.max(inv[1]![1]! * residualVariance, 0));
    if (a < 0) {
      const varA = inv[0]![0]! * residualVariance;
      const varB = inv[1]![1]! * residualVariance;
      const covAB = inv[0]![1]! * residualVariance;
      const dVertexdB = -1 / (2 * a);
      const dVertexdA = b / (2 * a * a);
      const vertexVar =
        dVertexdA * dVertexdA * varA +
        dVertexdB * dVertexdB * varB +
        2 * dVertexdA * dVertexdB * covAB;
      vertexStandardError = Math.sqrt(Math.max(vertexVar, 0));
    }
  }

  const vertexX = a < 0 ? -b / (2 * a) : null;
  return {
    a,
    b,
    c,
    vertexX,
    residualStandardDeviation:
      residualVariance === null ? null : Math.sqrt(residualVariance),
    standardErrorA,
    standardErrorB,
    vertexStandardError,
  };
}
