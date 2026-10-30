/** Presentation archive only. Historical ledgers and agent candidate sources are retained. */
export const archivedStrategyIds = [
 'midday-orb-quote-10-v1','midday-consolidation-10-v1',
 'ema-pullback-10-v1','ema-core-nifty-10-v2',
 'baseline','screener-orb','range-hold','range-failure-exit','agent-recovery',
 'orb-extension-risk-v1',
];
export const strategyVisible = (id:string) => !archivedStrategyIds.includes(id);
export const strategyVisibility = {archivedStrategyIds, note:'Showing retained strategies only. Paused research strategies and legacy cohorts are hidden; their original records are preserved. Historical totals cover the strategies shown, not every experiment ever run.'};
