import {SOURCES} from './sources.mjs';
import {digest,plain,classBody,parseListing,mofcomUnitUrl,eventId} from './parsers.mjs';
import {openStore} from './store.mjs';

export function makeHttpReader({fetchImpl=fetch,userAgent='EnergyFuelsResearchCollector/1.0 (personal public-news monitor)',timeoutMs=15000,maxBytes=2_000_000,minimumHostIntervalMs=300}={}) {
 const allowed=new Set(SOURCES.map(s=>new URL(s.url).hostname)),lastRequest=new Map();
 return async function read(url){
  const original=new URL(url);if(original.protocol!=='https:'||!allowed.has(original.hostname))throw new Error('URL outside source allowlist');
  let current=original;
  for(let redirects=0;redirects<4;redirects++){
   if(current.protocol!=='https:'||current.hostname!==original.hostname)throw new Error('Cross-host redirect blocked');
   const pause=minimumHostIntervalMs-(Date.now()-(lastRequest.get(current.hostname)||0));if(pause>0)await new Promise(r=>setTimeout(r,pause));
   lastRequest.set(current.hostname,Date.now());
   const response=await fetchImpl(current.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{'user-agent':userAgent,accept:'application/rss+xml,application/json,text/html,text/xml;q=0.9', 'accept-encoding':'gzip, deflate'}});
   if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new Error('Redirect without location');current=new URL(location,current);continue;}
   if(response.status!==200){await response.body?.cancel();throw new Error(`HTTP ${response.status} at ${current.hostname}`);}
   if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('Source exceeds response size limit');}
   const chunks=[];let bytes=0;
   for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes){throw new Error('Source exceeds response size limit');}chunks.push(chunk);}
   const buffer=Buffer.concat(chunks),header=response.headers.get('content-type')||'';
   const encoding=/iso-8859-1|windows-1252/i.test(header+' '+buffer.subarray(0,160).toString('ascii'))?'windows-1252':'utf-8';
   const body=new TextDecoder(encoding).decode(buffer);
   return {body,receipt:{url:current.href,status:200,contentType:header,bytes,sha256:digest(buffer),fetchedAt:new Date().toISOString()}};
  }throw new Error('Too many redirects');
 };
}

export async function loadSource(source,read) {
 const fetched=await read(source.url),receipts=[fetched.receipt];let text=fetched.body;
 if(source.kind==='mofcom'){const unit=await read(mofcomUnitUrl(text,source));text=unit.body;receipts.push(unit.receipt);}
 const items=parseListing(text,source);
 if(!items.length)throw new Error('No parseable items: empty feed or source layout changed; not interpreted as no news');
 const maximumItems=source.kind==='sec'?2000:100;
 if(items.length>maximumItems)throw new Error(`Source exceeds ${maximumItems}-item safety limit; investigate rather than truncate silently`);
 const seen=new Set();let sourceTextBytes=0;
 for(const item of items){
  const id=eventId(item);if(seen.has(id))throw new Error('Duplicate source identity; refusing ambiguous source snapshot');seen.add(id);
  if(source.articleBodies){
   const article=await read(item.url);receipts.push(article.receipt);
   item.bodyText=plain(classBody(article.body,'wd_news_body'));
   if(item.bodyText.length<100)throw new Error('Company article body unexpectedly short');
  }
  sourceTextBytes+=Buffer.byteLength(JSON.stringify(item));
  if(sourceTextBytes>1_500_000)throw new Error('Source text exceeds 1.5 MB processing limit; no silent truncation');
 }
 return {items,receipts};
}

export async function readStatus(directory){const store=await openStore(directory);try{return store.status();}finally{store.close();}}
export async function listPendingNotices(directory,options={}){const store=await openStore(directory);try{return store.pending(options);}finally{store.close();}}
export async function acknowledgeDelivery({directory,noticeId,receipt}){const store=await openStore(directory);try{return store.acknowledge(noticeId,receipt);}finally{store.close();}}
export async function recordRiskReview({directory,...review}){const store=await openStore(directory);try{return store.riskReview(review);}finally{store.close();}}

export async function collect({directory,sources=SOURCES,read=makeHttpReader(),now=new Date().toISOString(),maxRequests=40,runBudgetMs=120000,storeFactory=openStore}) {
 if(!Array.isArray(sources)||!sources.length||sources.length>12)throw new Error('Select 1 to 12 source profiles');
 if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error('Duplicate source profile');
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>50)throw new Error('Request budget must be between 1 and 50');
 if(!Number.isFinite(runBudgetMs)||runBudgetMs<1||runBudgetMs>180000)throw new Error('Run budget must be at most 180 seconds');
 if(Number.isNaN(Date.parse(now)))throw new Error('Invalid scan time');
 let requests=0;const started=performance.now();
 const boundedRead=async url=>{
  if(requests>=maxRequests)throw new Error('Per-run HTTP request limit reached');
  if(performance.now()-started>runBudgetMs)throw new Error('Per-run time limit reached');
  requests++;return read(url);
 };
 const store=await storeFactory(directory);
 try{
  const results=[];
  for(const source of sources){
   let loaded;
   try{loaded=await loadSource(source,boundedRead);}
   catch(err){
    store.sourceFailure(source,err,now);
    results.push({sourceId:source.id,error:String(err.message),baseline:false,notices:[]});continue;
   }
   // Storage failures are fatal. A source failure must never camouflage a failed commit.
   results.push(store.applySnapshot(source,loaded.items,now,{receipts:loaded.receipts,startedAt:now}));
  }
  const degraded=results.some(r=>r.error||r.warnings?.length);
  const lastRun={at:now,status:degraded?'DEGRADED':'OK',sources:results.length,requests,externalMessagesSent:0,tradesPlaced:0};
  store.transaction(()=>store.setMeta('lastRun',lastRun));
  const status=store.status();return {...lastRun,results,pendingNotices:status.pendingNotices,totalEvents:status.totalEvents};
 }finally{store.close();}
}
