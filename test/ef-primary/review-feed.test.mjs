import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore,openReadOnlyStore} from '../../ef-primary/store.mjs';
import {listReviewFeed,readStatus,acknowledgeDelivery,recordRiskReview} from '../../ef-primary/collector.mjs';
import runtimeModule from '../../ef-primary-runtime-v1.js';
const {createEfPrimaryRuntime}=runtimeModule;
const T='2026-11-05T12:00:00.000Z';
const source={id:'doe-main',publisher:'us-doe',url:'https://www.energy.gov/newsroom',scope:'synthetic'};
const item=(id,title='Nuclear project')=>({url:`https://www.energy.gov/articles/${id}`,title,summary:'Synthetic public listing',publishedAt:T,publishedRaw:T});
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ef-review-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function seed(t){const dir=await directory(t),s=await openStore(dir);s.applySnapshot(source,[item('baseline')],T);const result=s.applySnapshot(source,[item('a'),item('b','Unclassified subject')],'2026-11-05T12:10:00.000Z');s.close();return {dir,ids:result.notices};}
async function logicalState(dir){const s=await openReadOnlyStore(dir);try{return ['meta','sources','events','revisions','observations','outbox','risk_reviews'].map(table=>s.db.prepare(`SELECT * FROM ${table}`).all());}finally{s.close();}}

test('delivered and unclassified source notices remain available across reopening without changing stored state',async t=>{
 const {dir,ids}=await seed(t);await acknowledgeDelivery({directory:dir,noticeId:ids[0],receipt:{provider:'telegram',messageId:'PRIVATE-RECEIPT',deliveredAt:T}});
 const before=await logicalState(dir),page=await listReviewFeed(dir);
 assert.equal(page.items.length,2);assert.equal(page.items[0].transportStatus,'delivered');assert.equal(page.items[1].classification.queue,'UNCLASSIFIED_REVIEW');
 assert.equal(page.nativeFokusAutomationConnected,false);assert.equal(page.consumerAcknowledged,false);
 assert.deepEqual(await logicalState(dir),before);assert.deepEqual(await listReviewFeed(dir),page);
 assert.doesNotMatch(JSON.stringify(page),/PRIVATE-RECEIPT|deliveryReceipt|messageId|bodyText|summary/);
});

test('historical A-B-A revisions keep their exact snapshot and observation identity after delivery',async t=>{
 const {dir,ids}=await seed(t);await acknowledgeDelivery({directory:dir,noticeId:ids[0],receipt:{provider:'telegram',messageId:'8',deliveredAt:T}});
 const s=await openStore(dir);s.applySnapshot(source,[item('a','Revised nuclear project')],'2026-11-05T12:20:00Z');s.applySnapshot(source,[item('a')],'2026-11-05T12:30:00Z');s.close();
 const page=await listReviewFeed(dir),notices=page.items.filter(n=>n.eventId===page.items[0].eventId);
 assert.deepEqual(notices.map(n=>n.sourceSnapshot.title),['Nuclear project','Revised nuclear project','Nuclear project']);
 assert.deepEqual(notices.map(n=>n.observationRevision),[0,1,2]);assert.equal(new Set(notices.map(n=>n.id)).size,3);
 assert.equal(notices[0].contentVersion,notices[2].contentVersion);assert.equal(notices[0].transportStatus,'delivered');
});

test('snapshot pagination excludes concurrent inserts and skips private risk records without losing source records',async t=>{
 const {dir}=await seed(t);const first=await listReviewFeed(dir,{limit:1});
 await recordRiskReview({directory:dir,eventId:first.items[0].eventId,thesisId:'PRIVATE-PORTFOLIO',decisionVersion:'PRIVATE-V1',evidence:['PRIVATE-EVIDENCE'],explanation:'PRIVATE-RISK',now:T});
 const s=await openStore(dir);s.applySnapshot(source,[item('c')],'2026-11-05T12:40:00Z');s.close();
 const second=await listReviewFeed(dir,{afterSequence:first.nextAfterSequence,throughSequence:first.throughSequence,limit:1});
 assert.equal(second.items.length,1);assert.equal(second.hasMore,false);assert.equal(second.throughSequence,first.throughSequence);
 const third=await listReviewFeed(dir,{afterSequence:second.nextAfterSequence});assert.equal(third.items.length,1);assert.match(third.items[0].url,/\/c$/);
 assert.doesNotMatch(JSON.stringify([first,second,third]),/PRIVATE|RISK_REVIEW_REQUIRED|thesisId|decisionVersion/);
});

test('invalid options and future cursors fail without writes, creation or resetting established history',async t=>{
 const {dir}=await seed(t),before=await logicalState(dir);
 for(const options of [{afterSequence:-1},{afterSequence:1.1},{afterSequence:'1'},{afterSequence:Number.MAX_SAFE_INTEGER+1},{throughSequence:-1},{throughSequence:99},{afterSequence:99},{afterSequence:2,throughSequence:1},{limit:0},{limit:51},{limit:'2'},{unknown:true},null]){
  await assert.rejects(listReviewFeed(dir,options),{code:'INVALID_REVIEW_FEED_QUERY'});
 }
 assert.deepEqual(await logicalState(dir),before);
 const absent=path.join(dir,'absent');await assert.rejects(listReviewFeed(absent));await assert.rejects(fs.stat(absent),{code:'ENOENT'});
});

test('baseline-only and empty incremental histories do not manufacture retrospective notices',async t=>{
 const dir=await directory(t),s=await openStore(dir);s.applySnapshot(source,[item('baseline')],T);s.close();
 const page=await listReviewFeed(dir);assert.deepEqual(page.items,[]);assert.equal(page.throughSequence,0);assert.equal(page.nextAfterSequence,0);assert.equal(page.hasMore,false);
});

test('large article text and unrecognized stored properties are never returned in bounded metadata pages',async t=>{
 const {dir}=await seed(t),s=await openStore(dir);
 s.applySnapshot({...source,direct:true},[{...item('large','N'.repeat(5000)),bodyText:'PRIVATE_FULL_ARTICLE'.repeat(30000)}],'2026-11-05T12:50:00Z');s.close();
 const page=await listReviewFeed(dir);const entry=page.items.at(-1);
 assert.equal(entry.sourceSnapshot.title.length,900);assert.equal(entry.sourceSnapshot.titleTruncated,true);
 assert.ok(JSON.stringify(page).length<10000);assert.doesNotMatch(JSON.stringify(page),/PRIVATE_FULL_ARTICLE/);
});

test('missing historical version fails closed rather than exposing events.latest as an older revision',async t=>{
 const {dir}=await seed(t),s=await openStore(dir);s.db.exec('DELETE FROM revisions');s.close();
 await assert.rejects(listReviewFeed(dir),/Historical review snapshot/);
});

test('read-only connection refuses writes and public reads preserve delivery and risk-review counts',async t=>{
 const {dir}=await seed(t),before=await readStatus(dir),s=await openReadOnlyStore(dir);
 assert.throws(()=>s.db.exec("DELETE FROM outbox"),/readonly|read-only/i);s.close();await listReviewFeed(dir);
 const after=await readStatus(dir);for(const key of ['pendingNotices','pendingActionable','pendingUnclassified','deliveredNotices','riskReviews'])assert.equal(after[key],before[key]);
});

test('runtime query validation rejects ambiguity and cannot start collection, sending or acknowledgements',async()=>{
 let reads=0;const r=createEfPrimaryRuntime({enabled:true,directory:'unused',moduleLoader:async()=>({listReviewFeed:async(_dir,options)=>{reads++;return options;}})});
 for(const query of ['afterSequence=','afterSequence=-1','afterSequence=1e2','afterSequence=01','afterSequence=1&afterSequence=2','limit=51','limit=0','limit=2.5','key=secret','afterSequence=9007199254740992'])await assert.rejects(r.reviewFeed(new URLSearchParams(query)),{code:'INVALID_REVIEW_FEED_QUERY'});
 assert.equal(reads,0);assert.deepEqual(await r.reviewFeed(new URLSearchParams('afterSequence=1&throughSequence=3&limit=2')),{afterSequence:1,throughSequence:3,limit:2});
 assert.equal(r.getState().startedAt,null);assert.equal(r.getState().nativeFokusAutomationConnected,false);
 await assert.rejects(createEfPrimaryRuntime({enabled:false}).reviewFeed(),{code:'REVIEW_FEED_UNAVAILABLE'});
});

test('a separate restarted Node process sees the same source page after durable delivery',async t=>{
 const {dir,ids}=await seed(t);await acknowledgeDelivery({directory:dir,noticeId:ids[0],receipt:{provider:'telegram',messageId:'PRIVATE',deliveredAt:T}});
 const expected=await listReviewFeed(dir),moduleUrl=new URL('../../ef-primary/collector.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`const {listReviewFeed}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await listReviewFeed(process.argv[1])));`,dir],{stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,err);assert.deepEqual(JSON.parse(out),expected);
});

test('real HTTP route reads persisted source history, rejects writes and invalid cursors, and hides unavailable-store details',async t=>{
 const root=await directory(t),{dir,ids}=await seed(t),efDir=path.join(root,'ef-primary');await fs.rename(dir,efDir);
 await acknowledgeDelivery({directory:efDir,noticeId:ids[0],receipt:{provider:'telegram',messageId:'PRIVATE-HTTP-RECEIPT',deliveredAt:T}});
 const env={...process.env,PORT:'0',RADAR_PORT:'0',RADAR_BIND_ADDRESS:'127.0.0.1',RADAR_DATA_DIR:root,
  RADAR_EF_PRIMARY_ENABLED:'true',EF_POLL_MINUTES:'60',RADAR_FREE_ONLY:'true',RADAR_DELIVERY_MODE:'probe-only',KIMI_RESEARCH_MODE:'off',OIL_DATA_MODE:'free-proxy'};
 for(const key of ['APCA_API_KEY_ID','APCA_API_SECRET_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','TWELVE','TWELVE_BASIC_API_KEY','MASSIVE_API_KEY','RADAR_RECOVERY_BACKUP_ID','RADAR_DELIVERY_PROBE_ID','RADAR_BACKUP_ACCESS_KEY','NODE_OPTIONS'])delete env[key];
 const serverPath=fileURLToPath(new URL('../../server-v4.js',import.meta.url));
 const child=spawn(process.execPath,['-e','global.fetch=async()=>{throw new Error("No outbound network in isolated review-feed fixture")};require(process.argv[1]);',serverPath],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stderr.resume();
 try{
  const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Fixture server startup timeout')),8000);
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture server exited ${code}`));});
   child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/running on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
  });
  const base=`http://127.0.0.1:${port}`,url=base+'/api/ef-primary/review-feed';
  let ready=false;for(let i=0;i<100;i++){const status=await(await fetch(base+'/api/ef-primary/status')).json();if(!status.running&&status.lastCollectionAt){ready=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(ready,true);
  const before=await logicalState(efDir),response=await fetch(url+'?limit=1');assert.equal(response.status,200);
  const page=await response.json();assert.equal(page.items[0].transportStatus,'delivered');assert.equal(page.hasMore,true);assert.equal(page.nativeFokusAutomationConnected,false);
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  for(const query of ['limit=51','limit=1&limit=2','afterSequence=999','throughSequence=999','afterSequence=-1','private=secret'])assert.equal((await fetch(url+'?'+query)).status,400);
  assert.deepEqual(await logicalState(efDir),before);
  const original=path.join(efDir,'state.sqlite'),moved=path.join(efDir,'state.unavailable');await fs.rename(original,moved);
  try{const unavailable=await fetch(url);assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'Review feed unavailable'});}
  finally{await fs.rename(moved,original);}
 }finally{if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}}
});
