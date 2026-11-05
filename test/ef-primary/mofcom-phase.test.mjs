import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadSource,makeHttpReader,collect,readStatus} from '../../ef-primary/collector.mjs';
import {mofcomUnitUrl,parseListing} from '../../ef-primary/parsers.mjs';
import {SOURCES} from '../../ef-primary/sources.mjs';

const source=SOURCES.find(s=>s.id==='mofcom-remarks');
const fixture=name=>fs.readFile(new URL(`./fixtures/${name}.txt`,import.meta.url),'utf8');
const shell=await fixture('mofcom-shell'),listing=await fixture('mofcom');
const unitUrl=mofcomUnitUrl(shell,source),options={minimumHostIntervalMs:0,retryDelayMs:0};
const reset=()=>new TypeError('private outer error',{cause:Object.assign(new Error('private network detail'),{code:'ECONNRESET'})});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mofcom-phase-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));return dir;}

test('successful MOFCOM scan keeps the exact two URLs, source items and receipt evidence',async()=>{
 const urls=[];
 const read=makeHttpReader({...options,fetchImpl:async url=>{urls.push(url);return new Response(url===source.url?shell:listing);}});
 const loaded=await loadSource(source,read);
 assert.deepEqual(urls,[source.url,unitUrl]);assert.deepEqual(loaded.items,parseListing(listing,source));
 assert.deepEqual(loaded.receipts.map(r=>[r.url,r.status,r.requestAttempts,r.retryCount,r.recoveredErrors]),[[source.url,200,1,0,[]],[unitUrl,200,1,0,[]]]);
});

for(const phase of ['listing-shell','listing-unit'])test(`persistent reset identifies ${phase} after the existing single retry`,async()=>{
 const urls=[];
 const read=makeHttpReader({...options,fetchImpl:async url=>{urls.push(url);if(phase==='listing-unit'&&url===source.url)return new Response(shell);throw reset();}});
 await assert.rejects(loadSource(source,read),error=>{
  assert.match(error.message,new RegExp(`^MOFCOM ${phase}: HTTP connection failed at english\\.mofcom\\.gov\\.cn: ECONNRESET$`));
  assert.doesNotMatch(error.message,/private/);assert.match(error.cause.message,/ECONNRESET/);return true;
 });
 assert.deepEqual(urls,phase==='listing-shell'?[source.url,source.url]:[source.url,unitUrl,unitUrl]);
});

test('missing official query is distinguished from transport without a second request',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;return new Response('<html>No listing script</html>');}});
 await assert.rejects(loadSource(source,read),/^Error: MOFCOM listing-query: MOFCOM list query absent$/);assert.equal(calls,1);
});

test('malformed query JSON gets a fixed error without leaking the source excerpt',async()=>{
 const bad='<script url="/api-gateway/jpaas-publish-server/front/page/build/unit" querydata="private-query-secret-not-json"></script>';
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;return new Response(bad);}});
 await assert.rejects(loadSource(source,read),error=>{assert.equal(error.message,'MOFCOM listing-query: Invalid JSON in official listing data');assert.doesNotMatch(error.message,/private-query-secret/);return true;});assert.equal(calls,1);
});

test('malformed unit JSON identifies parsing without leaking body or retrying',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>new Response(++calls===1?shell:'private-body-secret-not-json')});
 await assert.rejects(loadSource(source,read),error=>{assert.equal(error.message,'MOFCOM listing-parse: Invalid JSON in official listing data');assert.doesNotMatch(error.message,/private-body-secret/);return true;});assert.equal(calls,2);
});

test('empty listing remains a parsing failure rather than a healthy no-news result',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>new Response(++calls===1?shell:JSON.stringify({success:true,data:{html:'<ul></ul>'}}))});
 await assert.rejects(loadSource(source,read),/MOFCOM listing-parse: No parseable items/);assert.equal(calls,2);
});

test('duplicate item validation remains visible as a listing parsing failure',async()=>{
 const data=JSON.parse(listing);data.data.html+=data.data.html;
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>new Response(++calls===1?shell:JSON.stringify(data))});
 await assert.rejects(loadSource(source,read),/MOFCOM listing-parse: Duplicate source identity/);assert.equal(calls,2);
});

test('access-denied unit remains visible and does not gain a retry',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>++calls===1?new Response(shell):new Response('denied',{status:403})});
 await assert.rejects(loadSource(source,read),/^Error: MOFCOM listing-unit: HTTP 403 at english\.mofcom\.gov\.cn$/);assert.equal(calls,2);
});

test('unit retry still cannot exceed the shared request budget',async t=>{
 const directory=await temp(t);let calls=0;
 const read=makeHttpReader({...options,fetchImpl:async()=>{if(++calls===1)return new Response(shell);throw reset();}});
 const result=await collect({directory,sources:[source],read,maxRequests:2});
 assert.equal(calls,2);assert.equal(result.requests,2);assert.equal(result.status,'DEGRADED');
 assert.match(result.results[0].error,/^MOFCOM listing-unit: Per-run HTTP request limit reached$/);
});

test('failed scan persists the phase while preserving the previous successful source evidence',async t=>{
 const directory=await temp(t),first='2026-11-05T12:00:00.000Z',second='2026-11-05T12:10:00.000Z';
 const good=makeHttpReader({...options,fetchImpl:async url=>new Response(url===source.url?shell:listing)});
 await collect({directory,sources:[source],read:good,now:first});const before=await readStatus(directory);
 const fail=makeHttpReader({...options,fetchImpl:async url=>{if(url===source.url)return new Response(shell);throw reset();}});
 const failed=await collect({directory,sources:[source],read:fail,now:second}),after=await readStatus(directory),state=after.sources[source.id];
 assert.equal(failed.status,'DEGRADED');assert.equal(state.status,'ERROR');assert.equal(state.lastSuccessAt,first);assert.equal(state.lastAttemptAt,second);
 assert.equal(state.consecutiveFailures,1);assert.equal(after.totalEvents,before.totalEvents);assert.equal(after.totalRevisions,before.totalRevisions);
 assert.deepEqual(state.receipts,before.sources[source.id].receipts);assert.deepEqual(state.windowIds,before.sources[source.id].windowIds);
 assert.match(state.error,/^MOFCOM listing-unit: .*ECONNRESET$/);assert.doesNotMatch(state.error,/private/);
});

test('non-MOFCOM failures retain the original error object and message',async()=>{
 const original=new Error('unchanged non-MOFCOM error');
 await assert.rejects(loadSource(SOURCES.find(s=>s.id==='ef-ir'),async()=>{throw original;}),error=>error===original);
});

test('arbitrary injected reader messages and causes cannot enter public MOFCOM status',async t=>{
 const directory=await temp(t),raw=new Error('private URL https://secret.invalid/?key=SECRET',{cause:new Error('private body SECRET')});
 const result=await collect({directory,sources:[source],read:async()=>{throw raw;}});
 assert.equal(result.results[0].error,'MOFCOM listing-shell: Unclassified official source failure');
 const state=await readStatus(directory);assert.doesNotMatch(JSON.stringify(state),/SECRET|secret\.invalid|private body/);
});

test('recovered unit reset remains successful with receipt evidence and no persisted source error',async t=>{
 const directory=await temp(t);let unitCalls=0;
 const read=makeHttpReader({...options,fetchImpl:async url=>{if(url===source.url)return new Response(shell);if(++unitCalls===1)throw reset();return new Response(listing);}});
 const result=await collect({directory,sources:[source],read}),state=(await readStatus(directory)).sources[source.id];
 assert.equal(result.status,'OK');assert.equal(result.requests,3);assert.equal(unitCalls,2);assert.equal(state.status,'OK');assert.equal(state.error,null);
 assert.equal(state.receipts[1].retryCount,1);assert.match(state.receipts[1].recoveredErrors[0],/ECONNRESET/);assert.equal(state.consecutiveFailures,0);
});
