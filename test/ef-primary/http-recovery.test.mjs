import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makeHttpReader,collect,readStatus} from '../../ef-primary/collector.mjs';

const url='https://www.energy.gov/feed';
const source={id:'doe-ne',publisher:'us-doe',url,kind:'rss',scope:'synthetic test'};
const xml='<rss><channel><item><title>Nuclear project update</title><link>https://www.energy.gov/articles/example</link><description>Neutral synthetic record</description></item></channel></rss>';
const networkError=(...codes)=>new TypeError('fetch failed',{cause:new AggregateError(codes.map(code=>Object.assign(new Error('private diagnostic message should not escape'),{code})))});
const options={minimumHostIntervalMs:0,retryDelayMs:0};
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ef-http-test-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));return dir;}

test('one transient connection retry succeeds with explicit recovery evidence and unchanged identity',async()=>{
 let calls=0;
 const read=makeHttpReader({...options,fetchImpl:async(input,opts)=>{calls++;assert.equal(input,url);assert.equal(opts.method,'GET');assert.match(opts.headers['user-agent'],/EnergyFuelsResearchCollector/);if(calls===1)throw networkError('ETIMEDOUT','ENETUNREACH');return new Response(xml);}});
 const result=await read(url);assert.equal(calls,2);assert.equal(result.body,xml);assert.equal(result.receipt.requestAttempts,2);assert.equal(result.receipt.retryCount,1);assert.match(result.receipt.recoveredErrors[0],/ETIMEDOUT,ENETUNREACH/);assert.doesNotMatch(result.receipt.recoveredErrors[0],/private diagnostic/);
});
test('persistent connection failure has only two attempts and retains cause codes in durable source status',async t=>{
 let calls=0;const dir=await temp(t);
 const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;throw networkError('ETIMEDOUT','ENETUNREACH');}});
 const result=await collect({directory:dir,sources:[source],read});assert.equal(result.status,'DEGRADED');assert.equal(calls,2);assert.equal(result.requests,2);
 const status=await readStatus(dir);assert.match(status.sources['doe-ne'].error,/ETIMEDOUT,ENETUNREACH/);assert.equal(status.sources['doe-ne'].baselineAt,undefined);assert.equal(status.totalEvents,0);
});
test('TLS, permanent DNS and unclassified failures are not retried',async()=>{
 for(const code of ['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','ENOTFOUND','UNKNOWN_ERROR']){
  let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;throw networkError(code);}});
  await assert.rejects(read(url),new RegExp(code));assert.equal(calls,1,code);
 }
});
test('access refusals, rate limits and Retry-After never trigger automatic retries',async()=>{
 for(const [status,headers]of [[401,{}],[403,{}],[404,{}],[429,{}],[503,{'retry-after':'120'}]]){
  let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;return new Response('unavailable',{status,headers});}});
  await assert.rejects(read(url),new RegExp(`HTTP ${status}`));assert.equal(calls,1);
 }
});
test('mixed permanent TLS and unreachable-address errors cannot authorize a retry',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;throw networkError('ENETUNREACH','CERT_HAS_EXPIRED');}});
 await assert.rejects(read(url),/ENETUNREACH,CERT_HAS_EXPIRED/);assert.equal(calls,1);
});
test('temporary server failure permits one bounded retry without accepting the failed body',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>++calls===1?new Response('temporary outage',{status:503}):new Response(xml)});
 const result=await read(url);assert.equal(result.body,xml);assert.equal(calls,2);assert.match(result.receipt.recoveredErrors[0],/HTTP 503/);
});
test('mid-body reset retries the whole GET and cannot concatenate partial content',async()=>{
 let calls=0;const read=makeHttpReader({...options,fetchImpl:async()=>{
  if(++calls===2)return new Response(xml);
  let pull=0;return new Response(new ReadableStream({pull(controller){if(++pull===1)controller.enqueue(new TextEncoder().encode('partial incorrect body'));else controller.error(networkError('ECONNRESET'));}}));
 }});
 const result=await read(url);assert.equal(result.body,xml);assert.match(result.receipt.recoveredErrors[0],/body failed.*ECONNRESET/);
});
test('request budget counts retry attempts, leaving later sources explicitly degraded',async t=>{
 const dir=await temp(t);let calls=0;
 const read=makeHttpReader({...options,fetchImpl:async()=>{if(++calls===1)throw networkError('ECONNRESET');return new Response(xml);}});
 const result=await collect({directory:dir,sources:[source,{...source,id:'other'}],read,maxRequests:2});
 assert.equal(calls,2);assert.equal(result.requests,2);assert.equal(result.results[0].baseline,true);assert.match(result.results[1].error,/request limit/);assert.equal(result.status,'DEGRADED');
});
test('same-host redirect also consumes the request budget and cannot evade it',async t=>{
 const dir=await temp(t);let calls=0;
 const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;return new Response('',{status:302,headers:{location:'/next'}});}});
 const result=await collect({directory:dir,sources:[source],read,maxRequests:1});assert.equal(calls,1);assert.equal(result.requests,1);assert.match(result.results[0].error,/request limit/);
});
test('exhausted wall-clock budget prevents the retry from starting',async t=>{
 const dir=await temp(t);let calls=0;
 const read=makeHttpReader({...options,fetchImpl:async()=>{calls++;await new Promise(r=>setTimeout(r,250));throw networkError('ECONNRESET');}});
 const result=await collect({directory:dir,sources:[source],read,runBudgetMs:150});assert.equal(calls,1);assert.equal(result.requests,1);assert.match(result.results[0].error,/time limit/);
});
test('each built-in request signal respects the smaller remaining scan deadline',async t=>{
 const dir=await temp(t);let elapsed=0,aborted=false;const signalBudgets=[];
 // Exercise the budget-to-signal contract deterministically. A busy runner can
 // spend the entire 150 ms opening SQLite before the old wall-clock test ever
 // reached fetch, which incorrectly looked like a missing request abort.
 t.mock.method(performance,'now',()=>elapsed);
 t.mock.method(AbortSignal,'timeout',ms=>{signalBudgets.push(ms);return AbortSignal.abort(Object.assign(new Error('synthetic deadline'),{name:'TimeoutError'}));});
 const read=makeHttpReader({...options,timeoutMs:1000,fetchImpl:async(_url,opts)=>{aborted=opts.signal.aborted;elapsed=151;opts.signal.throwIfAborted();return new Response(xml);}});
 const result=await collect({directory:dir,sources:[source],read,runBudgetMs:150});assert.equal(aborted,true);assert.deepEqual(signalBudgets,[150]);assert.equal(result.status,'DEGRADED');assert.equal(result.requests,1);
});
test('failed later scan retains the successful baseline and event history',async t=>{
 const dir=await temp(t);const success=makeHttpReader({...options,fetchImpl:async()=>new Response(xml)});
 await collect({directory:dir,sources:[source],read:success,now:'2026-11-05T12:00:00Z'});
 const fail=makeHttpReader({...options,fetchImpl:async()=>{throw networkError('ETIMEDOUT');}});
 await collect({directory:dir,sources:[source],read:fail,now:'2026-11-05T12:10:00Z'});
 const state=await readStatus(dir);assert.equal(state.totalEvents,1);assert.equal(state.sources['doe-ne'].baselineAt,'2026-11-05T12:00:00Z');assert.equal(state.sources['doe-ne'].status,'ERROR');assert.match(state.sources['doe-ne'].error,/ETIMEDOUT/);
});
test('oversize response and unsafe redirect are never retried',async()=>{
 for(const response of [()=>new Response('x'.repeat(11)),()=>new Response('',{status:302,headers:{location:'https://other.invalid/'}})]){
  let calls=0;const read=makeHttpReader({...options,maxBytes:10,fetchImpl:async()=>{calls++;return response();}});await assert.rejects(read(url));assert.equal(calls,1);
 }
});
