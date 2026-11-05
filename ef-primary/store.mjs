import {DatabaseSync} from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalUrl,digest,eventId,classify} from './parsers.mjs';

const SCHEMA=2;
const MAX_DATABASE_PAGES=65536; // 256 MiB at the fixed 4 KiB page size; no silent pruning.
const parse=value=>value?JSON.parse(value):null;
const pack=value=>JSON.stringify(value);
const sqlSchema=`
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,data TEXT NOT NULL,snapshot_started_at TEXT) STRICT;
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,url TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,latest TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS revisions(event_id TEXT NOT NULL REFERENCES events(id),version TEXT NOT NULL,first_seen TEXT NOT NULL,source_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(event_id,version)) STRICT;
 CREATE TABLE IF NOT EXISTS observations(event_id TEXT NOT NULL REFERENCES events(id),source_id TEXT NOT NULL,version TEXT NOT NULL,revision INTEGER NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,publisher TEXT NOT NULL,PRIMARY KEY(event_id,source_id)) STRICT;
 CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL REFERENCES events(id),kind TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','delivered')),receipt TEXT,data TEXT NOT NULL) STRICT;
 CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,sequence);
 CREATE INDEX IF NOT EXISTS outbox_pending_classified ON outbox(status,json_extract(data,'$.classification.queue'),sequence);
 CREATE TABLE IF NOT EXISTS risk_reviews(review_key TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),notice_id TEXT NOT NULL REFERENCES outbox(id),data TEXT NOT NULL) STRICT;
`;

export class SqliteStore {
 constructor(filename,{allowCreate=false,busyTimeoutMs=2000,beforeSchemaCommit}={}) {
  this.db=new DatabaseSync(filename);
  try{
   this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${Math.max(0,Math.min(10000,Math.floor(busyTimeoutMs)))}; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;`);
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
   if(!tables&&!allowCreate)throw new Error('Unrecognized/empty database: refusing to reset established history');
   if(!tables){
    this.db.exec('PRAGMA page_size=4096;');
    this.transaction(()=>{this.db.exec(sqlSchema);this.setMeta('schema',SCHEMA);beforeSchemaCommit?.();});
   }
   if(this.getMeta('schema')!==SCHEMA)throw new Error('Unsupported database schema');
   if(Number(this.db.prepare('PRAGMA page_size').get().page_size)!==4096)throw new Error('Unexpected database page size');
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=128; PRAGMA max_page_count=${MAX_DATABASE_PAGES};`);
  }catch(err){this.db.close();throw err;}
 }
 close(){this.db.close();}
 transaction(action){
  this.db.exec('BEGIN IMMEDIATE');
  try{const result=action();if(result&&typeof result.then==='function')throw new Error('SQLite transaction must be synchronous; never hold across network I/O');this.db.exec('COMMIT');return result;}
  catch(err){try{this.db.exec('ROLLBACK');}catch{}throw err;}
 }
 getMeta(key){return parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value);}
 setMeta(key,value){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,pack(value));}
 source(id){return parse(this.db.prepare('SELECT data FROM sources WHERE id=?').get(id)?.data);}
 putSource(id,data,startedAt){this.db.prepare('INSERT INTO sources(id,data,snapshot_started_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,snapshot_started_at=excluded.snapshot_started_at').run(id,pack(data),startedAt);}
 insertNotice(notice){
  const {deliveryReceipt,deliveryStatus,...data}=notice;
  const result=this.db.prepare('INSERT INTO outbox(id,event_id,kind,created_at,status,receipt,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(notice.id,notice.eventId,notice.kind,notice.createdAt,deliveryStatus||'pending',deliveryReceipt?pack(deliveryReceipt):null,pack(data));
  return Number(result.changes)>0?notice.id:null;
 }
 notice(event,item,source,version,kind,now,details={}){
  const age=item.publishedAt?Date.parse(now)-Date.parse(item.publishedAt):NaN;
  return {id:`notice:${digest(pack([event.id,kind,version]))}`,eventId:event.id,sourceId:source.id,publisher:source.publisher,kind,version,createdAt:now,title:item.title,url:event.url,
   classification:classify(item,source),novelty:'FIRST_OBSERVED_BY_THIS_COLLECTOR_ONLY',publicationTimeStatus:!Number.isFinite(age)?'UNKNOWN':age<0?'FUTURE_DATED_UNVERIFIED':'SOURCE_TIMESTAMP',publishedAt:item.publishedAt||null,
   deliveryStatus:'pending',deliveryReceipt:null,...details};
 }
 applySnapshot(source,items,now,{receipts=[],startedAt=now,beforeCommit}={}){
  return this.transaction(()=>{
   const row=this.db.prepare('SELECT data,snapshot_started_at FROM sources WHERE id=?').get(source.id),old=parse(row?.data),baseline=!old?.baselineAt;
   if(row?.snapshot_started_at&&startedAt<row.snapshot_started_at)return {sourceId:source.id,baseline:false,staleSnapshotIgnored:true,notices:[]};
   const notices=[],ids=[];let newEvents=0,updates=0;
   const getEvent=this.db.prepare('SELECT id,url FROM events WHERE id=?');
   const getObservation=this.db.prepare('SELECT version,revision,first_seen FROM observations WHERE event_id=? AND source_id=?');
   const insertEvent=this.db.prepare('INSERT INTO events(id,url,first_seen,last_seen,latest) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,latest=excluded.latest');
   const insertRevision=this.db.prepare('INSERT INTO revisions(event_id,version,first_seen,source_id,data) VALUES(?,?,?,?,?) ON CONFLICT(event_id,version) DO NOTHING');
   const upsertObservation=this.db.prepare('INSERT INTO observations(event_id,source_id,version,revision,first_seen,last_seen,publisher) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id,source_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,last_seen=excluded.last_seen,publisher=excluded.publisher');
   for(const input of items){
    const item={...input,url:canonicalUrl(input.url,source.url)},id=eventId(item);ids.push(id);
    const semantic={title:item.title,summary:item.summary||'',bodyText:item.bodyText||null,publishedAt:item.publishedAt||null,publishedRaw:item.publishedRaw||null,form:item.form||null};
    const version=digest(pack(semantic)),existing=getEvent.get(id),previous=getObservation.get(id,source.id),changed=!!previous&&previous.version!==version;
    const revision=(previous?.revision||0)+(changed?1:0);
    insertEvent.run(id,item.url,now,now,pack(item));
    insertRevision.run(id,version,now,source.id,pack(semantic));
    upsertObservation.run(id,source.id,version,revision,previous?.first_seen||now,now,source.publisher);
    if(!existing)newEvents++;
    if(!baseline&&(!existing||changed)){
     const kind=existing?'SOURCE_UPDATED':'SOURCE_NEW';if(changed)updates++;
     const noticeVersion=changed?`${version}:${source.id}:${revision}`:version;
     const notice=this.notice({id,url:item.url},item,source,noticeVersion,kind,now,{contentVersion:version,observationRevision:revision,changeScope:source.articleBodies?'ARTICLE_BODY_AND_METADATA':'LISTING_METADATA_ONLY'});
     const inserted=this.insertNotice(notice);if(inserted)notices.push(inserted);
    }
   }
   const warnings=[];
   const discontinuity=old?.windowIds?.length&&!old.windowIds.some(id=>ids.includes(id));
   const unresolvedCoverageGap=old?.unresolvedCoverageGap||(discontinuity?{firstDetectedAt:now,reason:'WINDOW_DISCONTINUITY',resolution:'UNRESOLVED'}:null);
   if(unresolvedCoverageGap)warnings.push('WINDOW_DISCONTINUITY: an earlier listing gap remains unresolved; successful fetches do not prove backfill');
   const data={...old,status:'OK',baselineAt:old?.baselineAt||now,lastAttemptAt:now,lastSuccessAt:now,consecutiveFailures:0,error:null,itemCount:items.length,windowIds:ids,warnings,unresolvedCoverageGap,scope:source.scope,receipts};
   this.putSource(source.id,data,startedAt);
   beforeCommit?.();
   return {sourceId:source.id,baseline,items:items.length,newEvents,updates,notices,warnings};
  });
 }
 sourceFailure(source,error,now,startedAt=now){
  return this.transaction(()=>{
   const row=this.db.prepare('SELECT data,snapshot_started_at FROM sources WHERE id=?').get(source.id);
   if(row?.snapshot_started_at&&startedAt<row.snapshot_started_at)return;
   const old=parse(row?.data);
   this.putSource(source.id,{...old,status:'ERROR',lastAttemptAt:now,consecutiveFailures:(old?.consecutiveFailures||0)+1,error:String(error.message).slice(0,400),scope:source.scope},startedAt);
  });
 }
 status(){
  const counts=this.db.prepare("SELECT (SELECT count(*) FROM events) totalEvents,(SELECT count(*) FROM revisions) totalRevisions,(SELECT count(*) FROM outbox WHERE status='pending') pendingNotices,(SELECT count(*) FROM outbox WHERE status='pending' AND json_extract(data,'$.classification.queue')='REVIEW') pendingActionable,(SELECT count(*) FROM outbox WHERE status='pending' AND json_extract(data,'$.classification.queue')='UNCLASSIFIED_REVIEW') pendingUnclassified,(SELECT count(*) FROM outbox WHERE status='delivered') deliveredNotices,(SELECT count(*) FROM risk_reviews) riskReviews").get();
  const sources={};
  for(const row of this.db.prepare('SELECT id,data FROM sources ORDER BY id LIMIT 100').iterate()){
   const data=parse(row.data);delete data.windowIds; // Large baseline identity sets stay on disk.
   sources[row.id]=data;
  }
  const pageCount=Number(this.db.prepare('PRAGMA page_count').get().page_count);
  return {schema:SCHEMA,initialized:!!this.getMeta('initialized'),lastRun:this.getMeta('lastRun'),sources,...counts,storage:{engine:'sqlite',databaseBytes:pageCount*4096,maxDatabaseBytes:MAX_DATABASE_PAGES*4096,historyExpiry:false},externalSenderConfigured:false};
 }
 pending({limit=50,afterSequence=0,actionableOnly=false}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(afterSequence)||afterSequence<0)throw new Error('Pending query requires limit 1..100 and nonnegative sequence');
  if(typeof actionableOnly!=='boolean')throw new Error('actionableOnly must be boolean');
  const filter=actionableOnly?" AND json_extract(data,'$.classification.queue')='REVIEW'":'';
  return this.db.prepare("SELECT sequence,data,status,receipt FROM outbox WHERE status='pending' AND sequence>?"+filter+' ORDER BY sequence LIMIT ?').all(afterSequence,limit).map(r=>({...parse(r.data),sequence:r.sequence,deliveryStatus:r.status,deliveryReceipt:parse(r.receipt)}));
 }
 acknowledge(noticeId,receipt){
  for(const key of ['provider','messageId','deliveredAt'])if(typeof receipt?.[key]!=='string'||!receipt[key].trim())throw new Error('Delivery acknowledgement requires provider, message ID and delivery time');
  if(Number.isNaN(Date.parse(receipt.deliveredAt)))throw new Error('Invalid delivery time');
  return this.transaction(()=>{
   const old=this.db.prepare('SELECT status FROM outbox WHERE id=?').get(noticeId);if(!old)throw new Error('Unknown notice');
   if(old.status==='delivered')return {acknowledged:false};
   this.db.prepare("UPDATE outbox SET status='delivered',receipt=? WHERE id=? AND status='pending'").run(pack(receipt),noticeId);return {acknowledged:true};
  });
 }
 riskReview({eventId:id,thesisId,decisionVersion,evidence,explanation,now=new Date().toISOString()}){
  for(const value of [thesisId,decisionVersion,explanation])if(typeof value!=='string'||!value.trim())throw new Error('Risk review requires thesis, version and explanation');
  if(!Array.isArray(evidence)||!evidence.length||evidence.some(e=>typeof e!=='string'||!e.trim()))throw new Error('Risk review requires evidence references');
  return this.transaction(()=>{
   const event=this.db.prepare('SELECT id,url,latest FROM events WHERE id=?').get(id);if(!event)throw new Error('Risk review requires known source event');
   const key=digest(pack([id,thesisId,decisionVersion]));if(this.db.prepare('SELECT 1 FROM risk_reviews WHERE review_key=?').get(key))return null;
   const origin=this.db.prepare('SELECT source_id,publisher FROM observations WHERE event_id=? ORDER BY first_seen,source_id LIMIT 1').get(id);
   const source={id:origin?.source_id||'external-review',publisher:origin?.publisher||'external-review',direct:true};
   const notice=this.notice(event,parse(event.latest),source,key,'RISK_REVIEW_REQUIRED',now,{thesisId,decisionVersion,evidence,explanation,riskAssessmentStatus:'EXTERNAL_INPUT_NOT_INDEPENDENTLY_VALIDATED'});
   const noticeId=this.insertNotice(notice);if(!noticeId)throw new Error('Risk review/outbox consistency error');
   this.db.prepare('INSERT INTO risk_reviews(review_key,event_id,notice_id,data) VALUES(?,?,?,?)').run(key,id,noticeId,pack({thesisId,decisionVersion,evidence,explanation,recordedAt:now}));return noticeId;
  });
 }
 migrateLegacy(state){
  if(state?.schema!==1||!state.events||!state.sources||!state.notices||!state.riskReviews)throw new Error('Legacy state invalid; refusing rebaseline');
  if(this.getMeta('initialized'))throw new Error('Migration target already initialized');
  this.transaction(()=>{
   for(const [id,s]of Object.entries(state.sources))this.putSource(id,s,s.lastAttemptAt||null);
   const ie=this.db.prepare('INSERT INTO events(id,url,first_seen,last_seen,latest) VALUES(?,?,?,?,?)');
   const ir=this.db.prepare('INSERT INTO revisions(event_id,version,first_seen,source_id,data) VALUES(?,?,?,?,?)');
   const io=this.db.prepare('INSERT INTO observations(event_id,source_id,version,revision,first_seen,last_seen,publisher) VALUES(?,?,?,?,?,?,?)');
   for(const [id,e]of Object.entries(state.events)){
    if(e.id!==id||!e.latest||!Array.isArray(e.versions)||!e.observations)throw new Error('Legacy event invalid');
    ie.run(id,e.url,e.firstObservedAt,e.lastObservedAt||e.firstObservedAt,pack(e.latest));
    for(const v of e.versions){const {version,firstObservedAt,sourceId,...data}=v;ir.run(id,version,firstObservedAt,sourceId,pack(data));}
    for(const [sid,o]of Object.entries(e.observations))io.run(id,sid,o.version,o.revision||0,o.firstObservedAt,o.lastObservedAt,o.publisher);
   }
   for(const [id,n]of Object.entries(state.notices)){if(n.id!==id)throw new Error('Legacy notice invalid');this.insertNotice(n);}
   for(const [key,r]of Object.entries(state.riskReviews))this.db.prepare('INSERT INTO risk_reviews(review_key,event_id,notice_id,data) VALUES(?,?,?,?)').run(key,r.eventId,r.noticeId,pack(r));
   this.setMeta('lastRun',state.lastRun);this.setMeta('migration',{from:1,at:new Date().toISOString(),events:Object.keys(state.events).length,originalRetained:true});this.setMeta('initialized',true);
  });
 }
}

async function exists(file){try{return await fs.stat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function requireRegularFileOrAbsent(file){
 try{const s=await fs.lstat(file);if(s.isSymbolicLink()||!s.isFile()||s.nlink>1)throw new Error('State files must be regular files without symlinks/hardlinks');return s;}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function openStore(directory,{beforeSchemaCommit}={}){
 await fs.mkdir(directory,{recursive:true});
 if((await fs.lstat(directory)).isSymbolicLink())throw new Error('State directory must not be a symlink');
 const dbFile=path.join(directory,'state.sqlite'),marker=path.join(directory,'sqlite-initialized'),legacy=path.join(directory,'state.json'),initializing=path.join(directory,'sqlite-initializing');
 for(const filename of [dbFile,dbFile+'-wal',dbFile+'-shm',dbFile+'-journal',marker,legacy,initializing])await requireRegularFileOrAbsent(filename);
 const present=await exists(dbFile),marked=await exists(marker),legacyStat=await exists(legacy);
 if(!present&&marked)throw new Error('Established SQLite history missing; restore database, never rebaseline');
 if(!present&&!legacyStat&&await exists(path.join(directory,'initialized')))throw new Error('Legacy history missing; restore before migration');
 if(!present&&!marked&&!await exists(initializing)){
  let h;try{h=await fs.open(initializing,'wx',0o600);await h.writeFile(JSON.stringify({schema:SCHEMA,purpose:'first-initialization',databaseName:'state.sqlite',createdAt:new Date().toISOString()}));await h.sync();}
  catch(e){if(e.code!=='EEXIST')throw e;}finally{await h?.close();}
 }
 const reservation=await exists(initializing)?JSON.parse(await fs.readFile(initializing,'utf8')):null;
 const recoverableInitialization=!marked&&reservation?.schema===SCHEMA&&reservation?.purpose==='first-initialization'&&reservation?.databaseName==='state.sqlite';
 const store=new SqliteStore(dbFile,{allowCreate:!present||recoverableInitialization,beforeSchemaCommit});
 try{
  if(!store.getMeta('initialized')){
   if(marked||!recoverableInitialization)throw new Error('Established database lost initialization state');
   if(legacyStat){if(legacyStat.size>25_000_000)throw new Error('Legacy JSON exceeds 25 MB migration limit; use explicit offline migration');store.migrateLegacy(JSON.parse(await fs.readFile(legacy,'utf8')));}
   else store.transaction(()=>store.setMeta('initialized',true));
  }
  if(!marked){const h=await fs.open(marker,'a',0o600);try{await h.writeFile('SQLite schema 2; do not delete without restoring history\n');await h.sync();}finally{await h.close();}}
  if(reservation)await fs.unlink(initializing).catch(e=>{if(e.code!=='ENOENT')throw e;});
  return store;
 }catch(err){store.close();throw err;}
}
