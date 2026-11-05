import {SOURCES} from './sources.mjs';
import {digest,plain,classBody,parseListing,mofcomUnitUrl,eventId} from './parsers.mjs';
import {openStore,openReadOnlyStore} from './store.mjs';

const TRANSIENT_CODES=new Set(['EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
function errorCodes(error){
 const codes=[],queue=[error],seen=new Set();
 for(let i=0;i<queue.length&&i<12;i++){
  const value=queue[i];if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
  if(typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(value.code))codes.push(value.code);
  if(value.name==='TimeoutError')codes.push('TIMEOUT');
  if(value.cause)queue.push(value.cause);
  if(Array.isArray(value.errors))queue.push(...value.errors.slice(0,8));
 }
 return [...new Set(codes)].slice(0,8);
}
function transportError(error,host,stage){
 const codes=errorCodes(error),summary=codes.join(',')||'UNKNOWN_TRANSPORT_ERROR';
 const wrapped=new Error(`HTTP ${stage} failed at ${host}: ${summary}`,{cause:error});
 // A mixed failure must not let a transient address error override a TLS,
 // certificate, permission or other permanent/unknown failure.
 wrapped.transient=codes.length>0&&codes.every(code=>code==='TIMEOUT'||TRANSIENT_CODES.has(code));
 return wrapped;
}

export function makeHttpReader({fetchImpl=fetch,userAgent='EnergyFuelsResearchCollector/1.0 (personal public-news monitor)',timeoutMs=15000,maxBytes=2_000_000,minimumHostIntervalMs=300,retryDelayMs=500}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error('HTTP timeout must be 1..30000 ms');
 if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>2000)throw new Error('Retry delay must be 0..2000 ms');
 const allowed=new Set(SOURCES.map(s=>new URL(s.url).hostname)),lastRequest=new Map();
 const read=async function(url,{beforeRequest}={}){
  const original=new URL(url);if(original.protocol!=='https:'||!allowed.has(original.hostname))throw new Error('URL outside source allowlist');
  let requestAttempts=0;const recoveredErrors=[];
  // Only one retry of the same public GET. No alternate host, proxy, identity or
  // access-denied bypass. Redirects and retries consume the shared scan budget.
  for(let attempt=0;attempt<2;attempt++){
   let current=original;
   try{for(let redirects=0;redirects<4;redirects++){
   if(current.protocol!=='https:'||current.hostname!==original.hostname)throw new Error('Cross-host redirect blocked');
   const pause=minimumHostIntervalMs-(Date.now()-(lastRequest.get(current.hostname)||0));if(pause>0)await new Promise(r=>setTimeout(r,pause));
   const remaining=beforeRequest?.()??timeoutMs;
   lastRequest.set(current.hostname,Date.now());
   requestAttempts++;
   let response;
   try{response=await fetchImpl(current.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.ceil(Math.min(timeoutMs,remaining)))),headers:{'user-agent':userAgent,accept:'application/rss+xml,application/json,text/html,text/xml;q=0.9', 'accept-encoding':'gzip, deflate'}});}
   catch(error){throw transportError(error,current.hostname,'connection');}
   if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new Error('Redirect without location');current=new URL(location,current);continue;}
   if(response.status!==200){
    await response.body?.cancel();const error=new Error(`HTTP ${response.status} at ${current.hostname}`);
    // Retry-After blocks this reader's immediate retry. This local retry policy
    // does not persist a server-specified cooldown across scheduled scans.
    error.transient=[502,503,504].includes(response.status)&&!response.headers.has('retry-after');throw error;
   }
   if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('Source exceeds response size limit');}
   const chunks=[];let bytes=0;
   try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes){const error=new Error('Source exceeds response size limit');error.responseSizeLimit=true;throw error;}chunks.push(chunk);}}
   catch(error){if(error.responseSizeLimit)throw error;throw transportError(error,current.hostname,'body');}
   const buffer=Buffer.concat(chunks),header=response.headers.get('content-type')||'';
   const encoding=/iso-8859-1|windows-1252/i.test(header+' '+buffer.subarray(0,160).toString('ascii'))?'windows-1252':'utf-8';
   const body=new TextDecoder(encoding).decode(buffer);
   return {body,receipt:{url:current.href,status:200,contentType:header,bytes,sha256:digest(buffer),fetchedAt:new Date().toISOString(),requestAttempts,retryCount:attempt,recoveredErrors}};
   }throw new Error('Too many redirects');
   }catch(error){
    if(attempt===1||error.transient!==true)throw error;
    recoveredErrors.push(error.message.slice(0,250));
    if(retryDelayMs)await new Promise(r=>setTimeout(r,retryDelayMs));
   }
  }
 };
 Object.defineProperty(read,'supportsHttpBudget',{value:true});return read;
}

const MOFCOM_SAFE_ERRORS=new Set([
 'MOFCOM list query absent','Unexpected MOFCOM query','MOFCOM unsuccessful response',
 'No parseable items: empty feed or source layout changed; not interpreted as no news',
 'Duplicate source identity; refusing ambiguous source snapshot',
 'Source text exceeds 1.5 MB processing limit; no silent truncation',
 'Per-run HTTP request limit reached','Per-run time limit reached','Source exceeds response size limit',
 'URL outside source allowlist','Cross-host redirect blocked','Redirect without location','Too many redirects'
]);
function mofcomErrorDetail(error,phase){
 const message=String(error?.message||'');
 if(['listing-query','listing-parse'].includes(phase)&&error instanceof SyntaxError)return 'Invalid JSON in official listing data';
 const transport=/^HTTP (?:(?:connection|body) failed at english\.mofcom\.gov\.cn: [A-Z0-9_,]+|[1-5]\d{2} at english\.mofcom\.gov\.cn)$/.test(message);
 const itemLimit=/^Source exceeds \d{1,4}-item safety limit; investigate rather than truncate silently$/.test(message);
 return MOFCOM_SAFE_ERRORS.has(message)||transport||itemLimit?message:'Unclassified official source failure';
}

export async function loadSource(source,read) {
 let phase='listing-shell';
 try{
 const fetched=await read(source.url),receipts=[fetched.receipt];let text=fetched.body;
 if(source.kind==='mofcom'){
  phase='listing-query';const unitUrl=mofcomUnitUrl(text,source);
  phase='listing-unit';const unit=await read(unitUrl);text=unit.body;receipts.push(unit.receipt);
 }
 phase='listing-parse';
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
 }catch(error){
  if(source.kind!=='mofcom')throw error;
  // The reader has already completed its bounded retry. This annotation makes
  // no new request and must not expose JSON.parse's excerpt of source content.
  throw new Error(`MOFCOM ${phase}: ${mofcomErrorDetail(error,phase)}`,{cause:error});
 }
}

export async function readStatus(directory){const store=await openStore(directory);try{return store.status();}finally{store.close();}}
export async function listPendingNotices(directory,options={}){const store=await openStore(directory);try{return store.pending(options);}finally{store.close();}}
export async function listReviewFeed(directory,options={}){const store=await openReadOnlyStore(directory);try{return store.reviewFeed(options);}finally{store.close();}}
export async function acknowledgeDelivery({directory,noticeId,receipt}){const store=await openStore(directory);try{return store.acknowledge(noticeId,receipt);}finally{store.close();}}
export async function recordRiskReview({directory,...review}){const store=await openStore(directory);try{return store.riskReview(review);}finally{store.close();}}

export async function collect({directory,sources=SOURCES,read=makeHttpReader(),now=new Date().toISOString(),maxRequests=40,runBudgetMs=120000,storeFactory=openStore}) {
 if(!Array.isArray(sources)||!sources.length||sources.length>12)throw new Error('Select 1 to 12 source profiles');
 if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error('Duplicate source profile');
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>50)throw new Error('Request budget must be between 1 and 50');
 if(!Number.isFinite(runBudgetMs)||runBudgetMs<1||runBudgetMs>180000)throw new Error('Run budget must be at most 180 seconds');
 if(Number.isNaN(Date.parse(now)))throw new Error('Invalid scan time');
 let requests=0;const started=performance.now();
 const beforeRequest=()=>{
  if(requests>=maxRequests)throw new Error('Per-run HTTP request limit reached');
  const remaining=runBudgetMs-(performance.now()-started);
  if(remaining<=0)throw new Error('Per-run time limit reached');
  requests++;return remaining;
 };
 const boundedRead=async url=>{
  if(read.supportsHttpBudget)return read(url,{beforeRequest});
  beforeRequest();return read(url); // Injected parsers/fixtures keep the existing API.
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
