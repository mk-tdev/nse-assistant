export const TZ = 'Asia/Kolkata';
export const FIVE = 300_000;
export type Candle = { start: number; open: number; high: number; low: number; close: number; volume: number | null };
export type Calendar = { source: string; verified: boolean; sessions: string[] };
export type Batch = { candles: Candle[]; fetchedAt: number; source: string; candleStartVerified: boolean; missing: string[] };
export type Instrument = { securityId: string; symbol: string; name: string; exchangeSegment: 'NSE_EQ'; instrument: 'EQUITY' };
export function day(t: number): string { return new Date(t + 330 * 60_000).toISOString().slice(0, 10); }
export function minute(t: number): number { const d = new Date(t + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
export function at(date: string, time: string): number { return Date.parse(`${date}T${time}:00+05:30`); }
export function validDate(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s; }
export function validCandle(c: Candle): boolean {
  return [c.start,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.start % FIVE === 0 &&
    c.low > 0 && c.low <= Math.min(c.open,c.close) && c.high >= Math.max(c.open,c.close) &&
    (c.volume === null || Number.isFinite(c.volume) && c.volume >= 0);
}
export function metadata(batch: Batch, asOf: number, date: string) {
  const complete = batch.candles.filter(c => day(c.start) === date && c.start + FIVE <= asOf);
  const latestEnd = complete.length ? Math.max(...complete.map(c => c.start + FIVE)) : null;
  const expectedEnd = Math.min(at(date,'15:30'), Math.floor(asOf/FIVE)*FIVE);
  const lagMs = latestEnd === null ? null : Math.max(0,expectedEnd-latestEnd);
  return { source: batch.source, timeZone: TZ, fetchedAt: new Date(batch.fetchedAt).toISOString(),
    evaluatedAsOf: new Date(asOf).toISOString(), latestCompleteCandleEnd: latestEnd === null ? null : new Date(latestEnd).toISOString(),
    freshness: !batch.candleStartVerified || lagMs === null ? 'unknown' : lagMs > 0 ? 'stale' : 'fresh_as_of', lagMs,
    retrievalAgeMs: Math.max(0,Date.now()-batch.fetchedAt), missingData: [...batch.missing,...(batch.candleStartVerified?[]:['unverified_candle_timestamp_semantics'])],
    candleStartVerified: batch.candleStartVerified };
}
