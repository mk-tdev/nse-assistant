/** Recursive EMA with fixed SMA seeding. Index i is null until the seed bar (period-1). */
export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (period < 1 || closes.length < period || closes.some(v => !Number.isFinite(v))) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i]!;
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) out[i] = closes[i]! * k + out[i - 1]! * (1 - k);
  return out;
}
