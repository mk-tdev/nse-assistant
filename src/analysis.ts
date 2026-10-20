import { at, day, FIVE, metadata, minute, validCandle, type Batch, type Calendar, type Candle } from './model.js';
export function median(xs: number[]): number | null {
  if (!xs.length || xs.some(x=>!Number.isFinite(x))) return null;
  const a = [...xs].sort((x,y)=>x-y), i = Math.floor(a.length/2);
  return a.length%2 ? a[i]! : (a[i-1]!+a[i]!)/2;
}
/** Bar approximation, NOT exchange tick VWAP. Only pass completed bars up to the decision. */
export function vwap(cs: Candle[]): number | null {
  if (!cs.length || cs.some(c=>c.volume === null || !validCandle(c))) return null;
  const volume = cs.reduce((s,c)=>s+c.volume!,0);
  return volume > 0 ? cs.reduce((s,c)=>s+(c.high+c.low+c.close)/3*c.volume!,0)/volume : null;
}
export function relativeVolume(c: Candle, history: Candle[], previous20: string[]) {
  const volumes = previous20.map(d=>history.filter(h=>day(h.start)===d && minute(h.start)===minute(c.start)));
  if (previous20.length!==20 || new Set(previous20).size!==20 || previous20.some(d=>d>=day(c.start)) || volumes.some(cs=>cs.length!==1 || cs[0]!.volume === null || !validCandle(cs[0]!)))
    return { ratio: null, median: null, missing: true };
  const med = median(volumes.map(cs=>cs[0]!.volume!));
  return { ratio: med && c.volume !== null ? c.volume/med : null, median: med, missing: !med || c.volume === null };
}
export function analyzeApproximate(batch: Batch, calendar: Calendar, date: string, asOf: number) {
  const meta = metadata(batch,asOf,date), reasons = [...batch.missing];
  const base = { simulatedOnly: true, mode: 'historical_replay_or_paper_analysis', ...meta,
    vwapMethod: 'session cumulative HLC3 times bar volume / cumulative bar volume (approximation)',
    calendarSource: calendar.source, calendarVerified: calendar.verified, signal: null, openingRange: null };
  const block = () => ({ ...base, status: 'blocked', qualifiesUnderApproximateModel: false, missingData: [...new Set(reasons)], trade: null });
  if (date < '2026-10-21') reasons.push('strategy_start_date_2026-10-21');
  if (day(asOf)!==date) reasons.push('as_of_must_be_in_requested_session');
  if (!calendar.verified || !calendar.sessions.includes(date)) reasons.push('unverified_or_nontrading_session');
  const previous20 = [...new Set(calendar.sessions.filter(d=>d<date))].sort().slice(-20);
  if (previous20.length!==20) reasons.push('missing_previous_20_trading_sessions');
  if (!batch.candleStartVerified) reasons.push('unverified_candle_timestamp_semantics');
  if (meta.freshness!=='fresh_as_of') reasons.push('stale_or_missing_session_candles');
  if (batch.fetchedAt < asOf) reasons.push('snapshot_fetched_before_as_of');
  const cs = batch.candles.filter(c=>day(c.start)===date && minute(c.start)>=555 && minute(c.start)<930 && c.start+FIVE<=asOf).sort((a,b)=>a.start-b.start);
  if (cs.some(c=>!validCandle(c)) || new Set(cs.map(c=>c.start)).size!==cs.length) reasons.push('invalid_or_duplicate_candles');
  const end = Math.min(at(date,'15:30'), Math.floor(asOf/FIVE)*FIVE);
  for (let t=at(date,'09:15');t<end;t+=FIVE) if (!cs.some(c=>c.start===t)) reasons.push('missing_session_candle');
  if (cs.some(c=>c.volume===null)) reasons.push('missing_session_volume');
  if (asOf<at(date,'09:30')) reasons.push('opening_range_incomplete');
  if (reasons.length) return block();
  const range = cs.filter(c=>c.start<at(date,'09:30'));
  if (range.length!==3) { reasons.push('opening_range_incomplete'); return block(); }
  const high = Math.max(...range.map(c=>c.high)), low = Math.min(...range.map(c=>c.low));
  const candidates = cs.filter(c=>c.start>=at(date,'09:30') && c.start+FIVE<=at(date,'11:00'));
  for (const c of candidates) {
    const rv = relativeVolume(c,batch.candles,previous20);
    if (rv.missing) { reasons.push(`missing_same_time_volume_${new Date(c.start).toISOString()}`); return block(); }
    const vw = vwap(cs.filter(x=>x.start<=c.start));
    if (vw === null) { reasons.push('undefined_session_vwap'); return block(); }
    if (c.close<=high || c.close<=vw || rv.ratio!<1.5) continue;
    const signal = { candleStart: new Date(c.start).toISOString(), confirmedAt: new Date(c.start+FIVE).toISOString(), close:c.close, vwap:vw, relativeVolume:rv.ratio, medianSameTimeVolume:rv.median };
    const next = cs.find(x=>x.start===c.start+FIVE);
    if (!next) return { ...base, status:'signal_pending_next_completed_candle', qualifiesUnderApproximateModel:true, openingRange:{high,low}, signal, trade:null };
    const entry=next.open, target=entry+2*(entry-low);
    if (entry<=low) return {...base,status:'entry_rejected_gap_at_or_below_stop',qualifiesUnderApproximateModel:false,openingRange:{high,low},signal,trade:null};
    const trade = { entryAt:new Date(next.start).toISOString(),entry,stop:low,target,exitAt:null as string|null,exitPrice:null as number|null,exitReason:null as string|null };
    for (const bar of cs.filter(x=>x.start>=next.start)) {
      if (bar.start>=at(date,'15:15')) { trade.exitAt=new Date(bar.start).toISOString();trade.exitPrice=bar.open;trade.exitReason='15:15_time_exit';break; }
      if (bar.low<=low) { trade.exitAt=new Date(bar.start+FIVE).toISOString();trade.exitPrice=Math.min(bar.open,low);trade.exitReason=bar.high>=target?'stop_first_intrabar_ambiguity':'stop';break; }
      if (bar.high>=target) { trade.exitAt=new Date(bar.start+FIVE).toISOString();trade.exitPrice=target;trade.exitReason='2R_target';break; }
    }
    return { ...base, status:trade.exitReason?'simulated_closed':'simulated_open',qualifiesUnderApproximateModel:true, openingRange:{high,low},signal,trade };
  }
  return { ...base,status:'no_signal',qualifiesUnderApproximateModel:false,openingRange:{high,low},trade:null };
}

/** Exact strategy qualification is unavailable: OHLCV and a later quote do not establish exact VWAP at a past candle close. */
export function analyze(batch: Batch, calendar: Calendar, date: string, asOf: number) {
  const approximate = analyzeApproximate(batch, calendar, date, asOf);
  const { qualifiesUnderApproximateModel, signal, trade, status, ...details } = approximate;
  return {
    ...details,
    status: status === 'blocked' ? 'blocked' : 'exact_vwap_unverified',
    qualification: 'unverified',
    validSignal: false,
    missingData: [...new Set([...details.missingData, 'timestamp_aligned_exact_session_vwap'])],
    signal: null,
    trade: null,
    approximateAnalysis: {
      status,
      qualifiesUnderApproximateModel,
      candidate: signal,
      hypotheticalTrade: trade
    }
  };
}
