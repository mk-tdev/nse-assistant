/** Indicative intraday margin calculations only. This module has no order endpoint. */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {at,day,validDate} from './model.js';
export type MarginItem={symbol:string;securityId:string;lastPrice:number;exchangeSegment?:string;priceSource?:string};
export class MarginRecorder{
 private session='';private rows:Record<string,any>={};
 constructor(readonly dir:string,readonly env:NodeJS.ProcessEnv=process.env,readonly fetcher:typeof fetch=fetch){}
 async capture(items:MarginItem[],now=Date.now()){
  const session=day(now);if(session!==this.session){this.session=session;this.rows={};try{const saved=JSON.parse(await readFile(join(this.dir,'margin-'+session+'.json'),'utf8'));if(saved.session===session)this.rows=saved.rows??{};}catch{}}
  const item=items.find(i=>(i.exchangeSegment??'NSE_EQ')==='NSE_EQ'&&/^[A-Z0-9&_.-]{1,32}$/.test(i.symbol)&&/^\d+$/.test(i.securityId)&&Number.isFinite(i.lastPrice)&&i.lastPrice>0&&this.rows[i.symbol]?.status!=='available'&&(this.rows[i.symbol]?.attempts??0)<3&&now>=(this.rows[i.symbol]?.retryAt??0));if(!item)return false;
  const attempts=(this.rows[item.symbol]?.attempts??0)+1;
  try{
   if(!this.env.DHAN_ACCESS_TOKEN||!this.env.DHAN_CLIENT_ID)throw Error('MARGIN_CREDENTIALS_MISSING');
   const r=await this.fetcher('https://api.dhan.co/v2/margincalculator',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','access-token':this.env.DHAN_ACCESS_TOKEN},body:JSON.stringify({dhanClientId:this.env.DHAN_CLIENT_ID,exchangeSegment:'NSE_EQ',transactionType:'BUY',quantity:10,productType:'INTRADAY',securityId:item.securityId,price:item.lastPrice})});
   if(!r.ok)throw Error('DHAN_MARGIN_HTTP_'+r.status);const raw=await r.json() as any;const totalMargin=raw.totalMargin,leverage=Number(String(raw.leverage??'').replace(/[xX]$/,''));
   if(!Number.isFinite(totalMargin)||totalMargin<=0)throw Error('DHAN_MARGIN_INVALID_RESPONSE');
   this.rows[item.symbol]={status:'available',symbol:item.symbol,securityId:item.securityId,product:'INTRADAY',quantity:10,referencePrice:item.lastPrice,priceSource:item.priceSource??'REST quote snapshot',totalMargin,rate:Math.max(.2,totalMargin/(item.lastPrice*10)),reportedLeverage:Number.isFinite(leverage)&&leverage>0?leverage:null,checkedAt:new Date(now).toISOString(),attempts};
  }catch(e){this.rows[item.symbol]={status:'unavailable',symbol:item.symbol,attempts,retryAt:now+60000,checkedAt:new Date(now).toISOString(),error:e instanceof Error&&/^(DHAN_MARGIN_HTTP_\d+|DHAN_MARGIN_INVALID_RESPONSE|MARGIN_CREDENTIALS_MISSING)$/.test(e.message)?e.message:'MARGIN_CHECK_UNAVAILABLE'};}
  const path=join(this.dir,'margin-'+session+'.json');await writeFile(path+'.tmp',JSON.stringify({session,observedAt:new Date(now).toISOString(),source:'Dhan single-order margin calculator',policy:'Indicative INTRADAY BUY margin at the saved reference price; valid only for the checked session, not historical broker margin at entry. Missing symbols use unleveraged cash in report illustrations. No orders or account balances are stored.',rows:this.rows})+'\n',{mode:0o600});await rename(path+'.tmp',path);return true;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const session=process.argv[2]??day(Date.now());if(!validDate(session)||session!==day(Date.now()))throw Error('MARGIN_CHECK_CURRENT_SESSION_ONLY');if(Date.now()<at(session,'15:35'))throw Error('MARGIN_ONESHOT_AFTER_CLOSE_ONLY');const dir=process.env.RECORDER_DATA_DIR??'/data',report=JSON.parse(await readFile(join(dir,session+'.json'),'utf8'));
 const prices=[...(report.paper?.scanner?.rows??[]),...(report.paper?.research?.cohorts??[]).flatMap((c:any)=>c.scanner?.rows??[])],items=report.instruments.map((i:any)=>({...i,lastPrice:prices.find((p:any)=>p.symbol===i.symbol&&Number.isFinite(p.lastClose))?.lastClose,priceSource:'Saved session candle close; calculator check after capture'}));const recorder=new MarginRecorder(dir);let checks=0;for(let i=0;i<items.length&&day(Date.now())===session;i++){if(await recorder.capture(items))checks++;await new Promise(r=>setTimeout(r,1100));}console.log(JSON.stringify({paperOnly:true,session,calculatorChecks:checks,ordersPlaced:0}));
}
