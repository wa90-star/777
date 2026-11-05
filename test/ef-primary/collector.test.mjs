import {test,after} from 'node:test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {SOURCES} from '../../ef-primary/sources.mjs';
import {parseListing,parseRss,parseSec,classBody,plain,eventId,canonicalUrl,mofcomUnitUrl} from '../../ef-primary/parsers.mjs';
import {collect,readStatus,listPendingNotices,makeHttpReader,loadSource,acknowledgeDelivery,recordRiskReview} from '../../ef-primary/collector.mjs';
import {SqliteStore,openStore} from '../../ef-primary/store.mjs';

const memoryStores=[];
after(()=>memoryStores.forEach(s=>s.close()));
function emptyState(){const s=new SqliteStore(':memory:',{allowCreate:true});memoryStores.push(s);
 Object.defineProperty(s,'notices',{get:()=>Object.fromEntries(s.db.prepare('SELECT id,data,status,receipt FROM outbox LIMIT 100').all().map(r=>[r.id,{...JSON.parse(r.data),deliveryStatus:r.status,deliveryReceipt:r.receipt?JSON.parse(r.receipt):null}]))});
 Object.defineProperty(s,'events',{get:()=>Object.fromEntries(s.db.prepare('SELECT id FROM events LIMIT 100').all().map(r=>[r.id,{observations:Object.fromEntries(s.db.prepare('SELECT source_id FROM observations WHERE event_id=?').all(r.id).map(o=>[o.source_id,true]))}]))});
 return s;}
const applySnapshot=(s,src,items,now)=>s.applySnapshot(src,items,now);
const appendRiskReview=(s,r,now)=>s.riskReview({...r,now});
const acknowledgeNotice=(s,id,r)=>s.acknowledge(id,r);
async function readState(dir){const s=await readStatus(dir);s.notices=Object.fromEntries((await listPendingNotices(dir,{limit:100})).map(n=>[n.id,n]));return s;}

const t0='2026-11-05T12:00:00.000Z',t1='2026-11-05T12:15:00.000Z';
const source={id:'doe-ne',publisher:'us-doe',url:'https://www.energy.gov/feed',kind:'rss',scope:'test'};
const item=(n,extra={})=>({url:`https://www.energy.gov/articles/${n}`,title:`Nuclear project ${n}`,summary:'Primary statement',publishedAt:t0,publishedRaw:t0,...extra});
const fixture=async name=>fs.readFile(new URL(`./fixtures/${name}.txt`,import.meta.url),'utf8');
const xml=items=>`<?xml version="1.0"?><rss><channel>${items.map(i=>`<item><title>${i.title}</title><link>${i.url}</link><description>${i.summary||''}</description>${i.publishedAt?`<pubDate>${i.publishedAt}</pubDate>`:''}</item>`).join('')}</channel></rss>`;
const reader=body=>async url=>({body,receipt:{url,status:200,bytes:body.length}});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ef-collector-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('synthetic fixtures cover the observed primary-source structures and parser boundaries',async()=>{
 for(const [id,name,count]of [['ef-ir','ef-list',10],['sec','sec',3],['doe-ne','doe-ne',10],['doe-main','doe-main',10],['dod','dod',10],['mofcom-remarks','mofcom',15],['usgs','usgs',12],['eia','eia',1]]){
  const parsed=parseListing(await fixture(name),SOURCES.find(s=>s.id===id));assert.ok(parsed.length>=count,`${id} had ${parsed.length}`);assert.ok(parsed.every(x=>x.url.startsWith('https://')&&x.title));
 }
});
test('company article extraction excludes navigation; navigation/clock changes are not updates',async()=>{
 const text=await fixture('ef-article'),body=plain(classBody(text,'wd_news_body'));
 assert.ok(body.includes('Financial Highlights'));assert.ok(body.length>5000);
 const changed=text.replace('</body>','<nav>Generated 2030-01-01</nav></body>');assert.equal(plain(classBody(changed,'wd_news_body')),body);
});
test('MOFCOM loader derives a GET-only official same-host endpoint without evaluating scripts',async()=>{
 const s=SOURCES.find(s=>s.id==='mofcom-remarks'),url=mofcomUnitUrl(await fixture('mofcom-shell'),s);
 assert.equal(new URL(url).hostname,'english.mofcom.gov.cn');assert.equal(new URL(url).searchParams.get('pageType'),'column');
});
test('HTML pretending to be RSS and truncated RSS fail visibly',()=>{
 assert.throws(()=>parseRss('<html>Cloud challenge</html>',source));
 assert.throws(()=>parseRss('<rss><channel><item><title>x</title></channel></rss>',source));
 assert.throws(()=>parseRss('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss></rss>',source));
});
test('SEC accepts an authorized filing-agent accession but rejects a different issuer',async()=>{
 const raw=JSON.parse(await fixture('sec'));raw.filings.recent.accessionNumber[0]='0001104659-26-123456';
 assert.ok(parseSec(JSON.stringify(raw))[0].url.includes('/1385849/000110465926123456/'));
 raw.cik='999999';assert.throws(()=>parseSec(JSON.stringify(raw)),/issuer/);
});
test('first successful source snapshot establishes baseline with no retrospective alerts',()=>{
 const state=emptyState(),out=applySnapshot(state,source,[item('a')],t0);
 assert.equal(out.baseline,true);assert.equal(Object.keys(state.events).length,1);assert.equal(Object.keys(state.notices).length,0);
});
test('new notice is durable, unchanged repeat and restart do not produce a duplicate',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 const next=reader(xml([item('b'),item('a')]));const report=await collect({directory:dir,sources:[source],read:next,now:t1});
 assert.equal(report.pendingNotices,1);assert.equal(Object.values((await readState(dir)).notices)[0].deliveryStatus,'pending');
 const again=await collect({directory:dir,sources:[source],read:next,now:t1});assert.equal(again.pendingNotices,1);assert.deepEqual(again.results[0].notices,[]);
});
test('later risk decision survives unchanged article ordinary dedupe and prior ordinary acknowledgement',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);applySnapshot(state,source,[item('b'),item('a')],t1);
 const ordinary=Object.values(state.notices)[0];acknowledgeNotice(state,ordinary.id,{provider:'test',messageId:'42',deliveredAt:t1});
 const review={eventId:eventId(item('b')),thesisId:'supply',decisionVersion:'2026-11-05-1',evidence:['https://www.energy.gov/articles/b'],explanation:'Newly established effect on the supply assumption'};
 const first=appendRiskReview(state,review,t1);assert.ok(first);assert.equal(state.notices[first].kind,'RISK_REVIEW_REQUIRED');assert.equal(state.notices[first].deliveryStatus,'pending');
 assert.equal(appendRiskReview(state,review,t1),null);
 assert.ok(appendRiskReview(state,{...review,decisionVersion:'2026-11-05-2',explanation:'New evidence changes severity'},t1));
 assert.equal(state.notices[first].classification.tradePermission,false);
});
test('risk review without evidence cannot create an authoritative-looking notice',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);
 assert.throws(()=>appendRiskReview(state,{eventId:eventId(item('a')),thesisId:'x',decisionVersion:'1',explanation:'x',evidence:[]}));
});
test('same URL body correction and subsequent restoration are both observable',()=>{
 const state=emptyState(),s={...source,articleBodies:true};
 applySnapshot(state,s,[item('a',{bodyText:'Production continues'})],t0);
 applySnapshot(state,s,[item('a',{bodyText:'Production suspended'})],t1);
 applySnapshot(state,s,[item('a',{bodyText:'Production continues'})],t1);
 applySnapshot(state,s,[item('a',{bodyText:'Production suspended'})],t1);
 const notices=Object.values(state.notices);assert.equal(notices.length,3);assert.ok(notices.every(n=>n.kind==='SOURCE_UPDATED'));
});
test('same DOE article in another DOE channel enriches provenance without independent confirmation',()=>{
 const state=emptyState(),second={...source,id:'doe-main'};
 applySnapshot(state,source,[item('a')],t0);applySnapshot(state,second,[item('z')],t0);
 applySnapshot(state,second,[item('a'),item('z')],t1);
 assert.equal(Object.keys(state.events).length,2);assert.equal(Object.keys(state.notices).length,0);assert.equal(Object.keys(state.events[eventId(item('a'))].observations).length,2);
});
test('tracking query changes retain identity; identity-bearing query parameters are preserved',()=>{
 assert.equal(canonicalUrl('https://www.energy.gov/a?utm_source=x&id=2#more'),canonicalUrl('https://www.energy.gov/a?id=2'));
 assert.notEqual(eventId(item('a?doc=1')),eventId(item('a?doc=2')));
});
test('unknown or future publication timestamp never manufactures verified fresh news',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);
 applySnapshot(state,source,[item('b',{publishedAt:null,publishedRaw:null}),item('c',{publishedAt:'2099-01-01T00:00:00Z'}),item('a')],t1);
 const notices=Object.values(state.notices);assert.deepEqual(notices.map(n=>n.publicationTimeStatus).sort(),['FUTURE_DATED_UNVERIFIED','UNKNOWN']);
 assert.ok(notices.every(n=>n.novelty==='FIRST_OBSERVED_BY_THIS_COLLECTOR_ONLY'));
});
test('indirect/nonmatching items are retained, without pretending EF exposure is confirmed',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);applySnapshot(state,source,[item('b',{title:'An unfamiliar program',summary:''}),item('a')],t1);
 const n=Object.values(state.notices)[0];assert.equal(n.classification.queue,'UNCLASSIFIED_REVIEW');assert.equal(n.classification.efImpact,'UNASSESSED');
});
test('HTTP failure is a coverage gap; subsequent first success still baselines only that source',async t=>{
 const dir=await temp(t);let report=await collect({directory:dir,sources:[source],read:async()=>{throw new Error('HTTP 503');},now:t0});
 assert.equal(report.status,'DEGRADED');assert.equal((await readState(dir)).sources[source.id].baselineAt,undefined);
 report=await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t1});assert.equal(report.pendingNotices,0);assert.equal(report.results[0].baseline,true);
});
test('empty/broken successful HTTP response cannot erase a good baseline or history',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 const report=await collect({directory:dir,sources:[source],read:reader('<rss><channel></channel></rss>'),now:t1});
 assert.equal(report.status,'DEGRADED');assert.equal((await readState(dir)).sources[source.id].baselineAt,t0);assert.equal(report.totalEvents,1);
});
test('one failing source does not hide the independent successful source event',async t=>{
 const dir=await temp(t),s2={...source,id:'other',url:'https://www.energy.gov/second'};
 await collect({directory:dir,sources:[source,s2],read:reader(xml([item('a')])),now:t0});
 const report=await collect({directory:dir,sources:[source,s2],read:async url=>{if(url===s2.url)throw new Error('503');return reader(xml([item('b'),item('a')]))(url);},now:t1});
 assert.equal(report.status,'DEGRADED');assert.equal(report.pendingNotices,1);
});
test('window rollover is explicitly degraded rather than a full-coverage claim',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);const r=applySnapshot(state,source,[item('b')],t1);
 assert.ok(r.warnings[0].includes('WINDOW_DISCONTINUITY'));
 const subsequent=applySnapshot(state,source,[item('b')],t1);assert.ok(subsequent.warnings[0].includes('unresolved'));
});
test('persistence failure reports failure and retry can recover the new notice',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 await assert.rejects(collect({directory:dir,sources:[source],read:reader(xml([item('b'),item('a')])),now:t1,storeFactory:async directory=>{const s=await openStore(directory),apply=s.applySnapshot.bind(s);s.applySnapshot=(src,items,now,options)=>apply(src,items,now,{...options,beforeCommit:()=>{throw new Error('disk full');}});return s;}}),/disk full/);
 assert.equal(Object.keys((await readState(dir)).notices).length,0);
 const r=await collect({directory:dir,sources:[source],read:reader(xml([item('b'),item('a')])),now:t1});assert.equal(r.pendingNotices,1);
});
test('corrupt or lost established history refuses an automatic reset',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 await fs.writeFile(path.join(dir,'state.sqlite'),'{broken');await assert.rejects(readState(dir));
 await fs.unlink(path.join(dir,'state.sqlite'));await assert.rejects(readState(dir),/history missing/);
});
test('abandoned legacy JSON lock does not permanently block the SQLite collector',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'collector.lock'),'dead prototype process');
 const report=await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 assert.equal(report.status,'OK');assert.equal(await fs.readFile(path.join(dir,'collector.lock'),'utf8'),'dead prototype process');
});
test('delivery stays pending unless a concrete provider receipt is supplied',()=>{
 const state=emptyState();applySnapshot(state,source,[item('a')],t0);applySnapshot(state,source,[item('b'),item('a')],t1);const n=Object.values(state.notices)[0];
 assert.throws(()=>acknowledgeNotice(state,n.id,{provider:'x'}));assert.equal(n.deliveryStatus,'pending');
});
test('HTTP reader enforces status, host, redirects, response bounds and GET-only access',async()=>{
 let calls=0;const read=makeHttpReader({minimumHostIntervalMs:0,maxBytes:5,fetchImpl:async(url,options)=>{calls++;assert.equal(options.method,'GET');return new Response('too large');}});
 await assert.rejects(read('https://www.energy.gov/x'),/size limit/);
 await assert.rejects(read('https://example.com/private'),/allowlist/);assert.equal(calls,1);
 const redirect=makeHttpReader({minimumHostIntervalMs:0,fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://example.com/private'}})});
 await assert.rejects(redirect('https://www.energy.gov/x'),/Cross-host/);
 const blocked=makeHttpReader({minimumHostIntervalMs:0,fetchImpl:async()=>new Response('blocked',{status:403})});await assert.rejects(blocked('https://www.energy.gov/x'),/403/);
});
test('body fetch failure does not downgrade old full company text into a false deletion update',async()=>{
 const s=SOURCES.find(s=>s.id==='ef-ir'),listing=await fixture('ef-list');
 await assert.rejects(loadSource(s,async url=>{if(url===s.url)return reader(listing)(url);throw new Error('article failed');}),/article failed/);
});
test('bounded parsed source text prevents an oversized page from expanding the working set',async()=>{
 await assert.rejects(loadSource(source,reader(xml([item('a',{summary:'x'.repeat(1_510_000)})]))),/1.5 MB/);
});
test('bounded source and request budgets fail explicitly rather than growing paid work indefinitely',async t=>{
 const dir=await temp(t);await assert.rejects(collect({directory:dir,sources:Array.from({length:13},(_,i)=>({...source,id:String(i)})),read:reader(xml([item('a')]))}),/1 to 12/);
 const other={...source,id:'other'};
 const report=await collect({directory:dir,sources:[source,other],read:reader(xml([item('a')])),maxRequests:1,now:t0});
 assert.equal(report.status,'DEGRADED');assert.equal(report.requests,1);assert.match(report.results[1].error,/request limit/);
});

async function crashWorker(directory,mode){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../test-support/ef-primary-crash-worker.mjs',import.meta.url)),directory,mode],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  await new Promise((resolve,reject)=>{let stdout='',stderr='';const timer=setTimeout(()=>reject(new Error(`Worker readiness timeout: ${stderr}`)),10000);
   child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('READY')){clearTimeout(timer);resolve();}});
   child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);if(!stdout.includes('READY'))reject(new Error(`Worker exited prematurely: ${stderr}`));});
  });
 }finally{child.kill('SIGKILL');await exited;}
}
test('real process death inside a transaction rolls back and releases locks automatically',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 await crashWorker(dir,'before-commit');
 const status=await readStatus(dir);assert.equal(status.totalEvents,1);assert.equal(status.pendingNotices,0);
 const retry=await collect({directory:dir,sources:[source],read:reader(xml([item('b'),item('a')])),now:t1});assert.equal(retry.pendingNotices,1);
});
test('real process death after commit preserves the pending outbox across restart',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 await crashWorker(dir,'after-commit');
 assert.equal((await readStatus(dir)).pendingNotices,1);
 const retry=await collect({directory:dir,sources:[source],read:reader(xml([item('b'),item('a')])),now:t1});assert.equal(retry.pendingNotices,1);assert.deepEqual(retry.results[0].notices,[]);
});
test('real initial process death before schema commit is recoverable without resetting established history',async t=>{
 const dir=await temp(t);await crashWorker(dir,'initial-schema');
 assert.ok(await fs.stat(path.join(dir,'sqlite-initializing')));
 const status=await readStatus(dir);assert.equal(status.initialized,true);assert.equal(status.totalEvents,0);
 await assert.rejects(fs.stat(path.join(dir,'sqlite-initializing')),e=>e.code==='ENOENT');
 await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 assert.equal((await readStatus(dir)).totalEvents,1);
});
test('unmarked empty database is not silently classified as an interrupted first initialization',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'state.sqlite'),'');
 await assert.rejects(readStatus(dir),/Unrecognized/);
});
test('database symlink is rejected before opening or changing its target',async t=>{
 const dir=await temp(t),target=path.join(dir,'original.db'),link=path.join(dir,'state.sqlite');await fs.writeFile(target,'untouched');
 try{await fs.symlink(target,link,'file');}catch(e){if(e.code==='EPERM'){t.skip('Windows symlink privilege unavailable; Linux CI must run this case');return;}throw e;}
 await assert.rejects(readStatus(dir),/symlinks/);assert.equal(await fs.readFile(target,'utf8'),'untouched');
});
test('database hardlink is rejected before opening or changing its target',async t=>{
 const dir=await temp(t),target=path.join(dir,'original.db');await fs.writeFile(target,'untouched');await fs.link(target,path.join(dir,'state.sqlite'));
 await assert.rejects(readStatus(dir),/hardlinks/);assert.equal(await fs.readFile(target,'utf8'),'untouched');
});
test('a late older concurrent snapshot cannot roll the source backwards or create a false restoration',async t=>{
 const dir=await temp(t),first=await openStore(dir),second=await openStore(dir);
 try{
  first.applySnapshot(source,[item('a')],t0);second.applySnapshot(source,[item('b'),item('a')],t1);
  const stale=first.applySnapshot(source,[item('a',{summary:'old data'})],t0);
  assert.equal(stale.staleSnapshotIgnored,true);assert.equal(first.status().pendingNotices,1);assert.equal(first.source(source.id).lastSuccessAt,t1);
 }finally{first.close();second.close();}
});
test('SQL queue filtering skips unclassified work without falsely acknowledging it; pagination stays bounded',async t=>{
 const dir=await temp(t),s=await openStore(dir);
 try{
  s.applySnapshot(source,[item('a')],t0);
  const unclassified=Array.from({length:120},(_,n)=>item(`u-${n}`,{title:`Unknown program ${n}`,summary:''}));
  s.applySnapshot(source,[...unclassified,item('nuclear-event'),item('a')],t1);
 }finally{s.close();}
 const actionable=await listPendingNotices(dir,{limit:10,actionableOnly:true});assert.equal(actionable.length,1);assert.match(actionable[0].title,/nuclear-event/);
 const status=await readStatus(dir);assert.equal(status.pendingActionable,1);assert.equal(status.pendingUnclassified,120);assert.equal(status.deliveredNotices,0);
 const page=await listPendingNotices(dir,{limit:100});assert.equal(page.length,100);
 const next=await listPendingNotices(dir,{limit:100,afterSequence:page.at(-1).sequence});assert.equal(next.length,21);
 await assert.rejects(listPendingNotices(dir,{limit:101}),/1..100/);
});
test('provider acknowledgement and independent risk review remain durable via public API',async t=>{
 const dir=await temp(t);await collect({directory:dir,sources:[source],read:reader(xml([item('a')])),now:t0});
 await collect({directory:dir,sources:[source],read:reader(xml([item('b'),item('a')])),now:t1});
 const [n]=await listPendingNotices(dir);
 assert.equal((await acknowledgeDelivery({directory:dir,noticeId:n.id,receipt:{provider:'test',messageId:'7',deliveredAt:t1}})).acknowledged,true);
 const review={directory:dir,eventId:n.eventId,thesisId:'supply',decisionVersion:'2',evidence:[n.url],explanation:'Later evidenced effect',now:t1};
 assert.ok(await recordRiskReview(review));assert.equal(await recordRiskReview(review),null);
 const status=await readStatus(dir);assert.equal(status.deliveredNotices,1);assert.equal(status.pendingNotices,1);assert.equal(status.riskReviews,1);
});
test('JSON baseline migration preserves events, revisions, source baseline and original bytes',async t=>{
 const dir=await temp(t),input=item('a'),id=eventId(input),original=JSON.stringify({schema:1,sources:{'doe-ne':{baselineAt:t0,lastAttemptAt:t0,status:'OK',windowIds:[id]}},events:{[id]:{id,url:input.url,firstObservedAt:t0,lastObservedAt:t0,latest:input,versions:[{version:'legacy-v',firstObservedAt:t0,sourceId:'doe-ne',title:input.title}],observations:{'doe-ne':{version:'legacy-v',revision:0,firstObservedAt:t0,lastObservedAt:t0,publisher:'us-doe'}}}},notices:{},riskReviews:{},lastRun:{at:t0,status:'OK'}});
 await fs.writeFile(path.join(dir,'state.json'),original);await fs.writeFile(path.join(dir,'initialized'),'legacy');
 const status=await readStatus(dir);assert.equal(status.totalEvents,1);assert.equal(status.totalRevisions,1);assert.equal(status.sources['doe-ne'].baselineAt,t0);
 assert.equal(await fs.readFile(path.join(dir,'state.json'),'utf8'),original);
 const again=await readStatus(dir);assert.equal(again.totalEvents,1);
});
test('invalid legacy migration rolls back and is never replaced with an empty baseline',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({schema:1,sources:{},events:{broken:{}},notices:{},riskReviews:{}}));
 await assert.rejects(readStatus(dir),/Legacy event/);await assert.rejects(readStatus(dir),/Legacy event/);
});
test('database growth limit rejects a transaction while preserving existing source history',async t=>{
 const dir=await temp(t),s=await openStore(dir);
 try{
  s.applySnapshot(source,[item('a')],t0);
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const count=Number(s.db.prepare('PRAGMA page_count').get().page_count);s.db.exec(`PRAGMA max_page_count=${count}`);
  assert.throws(()=>s.applySnapshot(source,[item('b',{bodyText:'X'.repeat(200000)}),item('a')],t1),/full/i);
  assert.equal(s.status().totalEvents,1);assert.equal(s.status().pendingNotices,0);assert.equal(s.source(source.id).lastSuccessAt,t0);
 }finally{s.close();}
});
test('thousands of historical revisions stay on disk while status and pending APIs remain bounded',async t=>{
 const dir=await temp(t),s=await openStore(dir),id=eventId(item('a'));
 try{
  s.applySnapshot(source,[item('a')],t0);
  const insert=s.db.prepare('INSERT INTO revisions(event_id,version,first_seen,source_id,data) VALUES(?,?,?,?,?)');
  const payload=JSON.stringify({bodyText:'historical source text '.repeat(200)});
  s.transaction(()=>{for(let i=0;i<5000;i++)insert.run(id,`historical-${i}`,t0,source.id,payload);});
  s.applySnapshot(source,[item('b'),item('a')],t1);
  const status=s.status();assert.equal(status.totalRevisions,5002);assert.ok(status.storage.databaseBytes>10_000_000);assert.ok(JSON.stringify(status).length<10000);
  assert.equal(status.events,undefined);assert.equal(status.revisions,undefined);assert.equal(status.sources[source.id].windowIds,undefined);assert.equal(s.pending({limit:1}).length,1);
 }finally{s.close();}
});
