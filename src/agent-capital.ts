/** Full purchase-value exposure, without assumed broker leverage or profit recycling. */
export function agentCapital(positions:any[]){
 const round=(n:number)=>Math.round(n*100)/100;
 const events:{at:number;amount:number;positions:number;net:number}[]=[];
 let totalBuy=0,totalSell=0,unknownRelease=0;
 for(const p of positions){
  const amount=p.entry*p.quantity*(p.multiplier??1);
  if(!Number.isFinite(amount)||!Number.isFinite(p.entryAt))continue;
  totalBuy+=amount;events.push({at:p.entryAt,amount,positions:1,net:0});
  if(p.status==='closed'&&Number.isFinite(p.exit)&&Number.isFinite(p.exitAt)){
   totalSell+=p.exit*p.quantity*(p.multiplier??1);
   events.push({at:p.exitAt,amount:-amount,positions:-1,net:p.unknownOutcome?0:p.netPnl??0});
  }else if(p.status==='closed')unknownRelease++;
 }
 let deployed=0,count=0,peak=0,peakPositions=0,realizedNet=0;
 const timeline:{at:number;deployed:number;positions:number;realizedNet:number}[]=[];
 const grouped=new Map<number,typeof events>();for(const e of events){if(!grouped.has(e.at))grouped.set(e.at,[]);grouped.get(e.at)!.push(e);}
 for(const [at,rows] of [...grouped].sort((a,b)=>a[0]-b[0])){
  // Releases and entries recorded at the same millisecond are treated as simultaneous.
  for(const e of rows){deployed+=e.amount;count+=e.positions;realizedNet+=e.net;}
  peak=Math.max(peak,deployed);peakPositions=Math.max(peakPositions,count);
  timeline.push({at,deployed:round(Math.max(0,deployed)),positions:count,realizedNet:round(realizedNet)});
 }
 const costs=positions.reduce((n,p)=>n+(Number.isFinite(p.costs?.total)?p.costs.total:0),0);
 return {buyTurnover:round(totalBuy),sellTurnover:round(totalSell),peakPurchaseValue:round(peak),outstandingPurchaseValue:round(Math.max(0,deployed)),peakPositions,knownCosts:round(costs),capitalWithKnownCostBuffer:round(peak+costs),unknownRelease,timeline,
  policy:'Full entry purchase value of simultaneous positions (1x cash exposure), not broker margin or cumulative buy turnover. Same-millisecond releases and entries are netted. No leverage or profit recycling assumed. Peak plus all known modeled costs is a conservative cost-buffer illustration, not a guaranteed funding requirement; unresolved releases retain exposure and missing costs remain unknown.'};
}
