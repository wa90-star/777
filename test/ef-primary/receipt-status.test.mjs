import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {openStore} from '../../ef-primary/store.mjs';
import {readStatus,acknowledgeDelivery,recordRiskReview,listReviewFeed} from '../../ef-primary/collector.mjs';
const NOW=Date.now(),EARLY=new Date(NOW-60000).toISOString(),LATER=new Date(NOW-10000).toISOString();
const source={id:'doe-main',publisher:'us-doe',url:'https://www.energy.gov/newsroom',scope:'synthetic'};
const item=n=>({url:`https://www.energy.gov/articles/${n}`,title:'Synthetic nuclear notice '+n,publishedAt:EARLY});
async function seed(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ef-receipt-status-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const s=await openStore(directory);s.applySnapshot(source,[item('baseline')],EARLY);s.applySnapshot(source,[item('a'),item('b')],LATER);const notices=s.pending();s.close();return {directory,notices};}

test('stored source Telegram receipt remains visible in a separate process without exposing its ID',async t=>{
 const {directory,notices}=await seed(t);await acknowledgeDelivery({directory,noticeId:notices[0].id,receipt:{provider:'telegram',messageId:'91827461',deliveredAt:LATER}});
 const status=await readStatus(directory);assert.equal(status.lastSourceTelegramReceiptAt,LATER);assert.equal(status.deliveredNotices,1);
 assert.doesNotMatch(JSON.stringify(status),/91827461|messageId|receiptId/);
 const moduleUrl=new URL('../../ef-primary/collector.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`const {readStatus}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await readStatus(process.argv[1])));`,directory],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,err);
 const reread=JSON.parse(out);assert.equal(reread.lastSourceTelegramReceiptAt,LATER);assert.equal(reread.deliveredNotices,1);
});

test('private risk-review delivery and later non-Telegram receipt cannot replace source receipt evidence',async t=>{
 const {directory,notices}=await seed(t);await acknowledgeDelivery({directory,noticeId:notices[0].id,receipt:{provider:'telegram',messageId:'8',deliveredAt:EARLY}});
 await acknowledgeDelivery({directory,noticeId:notices[1].id,receipt:{provider:'other-provider',messageId:'9',deliveredAt:LATER}});
 const privateNotice=await recordRiskReview({directory,eventId:notices[0].eventId,thesisId:'PRIVATE_THESIS',decisionVersion:'PRIVATE_VERSION',evidence:['PRIVATE_EVIDENCE'],explanation:'PRIVATE_POSITION',now:LATER});
 await acknowledgeDelivery({directory,noticeId:privateNotice,receipt:{provider:'telegram',messageId:'76543219',deliveredAt:LATER}});
 const status=await readStatus(directory);assert.equal(status.lastSourceTelegramReceiptAt,EARLY);assert.doesNotMatch(JSON.stringify(status),/PRIVATE_/);
 assert.doesNotMatch(JSON.stringify(status),/76543219/);assert.doesNotMatch(JSON.stringify(await listReviewFeed(directory)),/PRIVATE_|76543219/);
});

test('a delivered source revision supplies evidence without changing source history during the status read',async t=>{
 const {directory}=await seed(t),s=await openStore(directory);
 s.applySnapshot(source,[{...item('a'),title:'Revised synthetic nuclear notice'}],LATER);
 const revision=s.pending().find(n=>n.kind==='SOURCE_UPDATED');assert.ok(revision);s.close();
 await acknowledgeDelivery({directory,noticeId:revision.id,receipt:{provider:'telegram',messageId:'21',deliveredAt:LATER}});
 const before=await listReviewFeed(directory);assert.equal((await readStatus(directory)).lastSourceTelegramReceiptAt,LATER);
 assert.deepEqual(await listReviewFeed(directory),before);
});

test('invalid, future, pending or malformed receipt cannot manufacture source-delivery proof',async t=>{
 const {directory,notices}=await seed(t),s=await openStore(directory);
 try{
  const receipts=[null,'not-json',JSON.stringify({provider:'telegram',messageId:'0',deliveredAt:LATER}),
   JSON.stringify({provider:'telegram',messageId:12,deliveredAt:LATER}),JSON.stringify({provider:'telegram',messageId:'9007199254740992',deliveredAt:LATER}),
   JSON.stringify({provider:'telegram',messageId:'12\u0000invalid',deliveredAt:LATER}),
   JSON.stringify({provider:'telegram',messageId:'12',deliveredAt:LATER+'\u0000invalid'}),
   JSON.stringify({provider:'telegram',messageId:'12',deliveredAt:'2026-02-30T12:00:00.000Z'}),
   JSON.stringify({provider:'telegram',messageId:'12',deliveredAt:new Date(NOW+86400000).toISOString()}),
   JSON.stringify({provider:'telegram',messageId:'12',deliveredAt:'2026-11-05'})];
  for(const receipt of receipts){s.db.prepare("UPDATE outbox SET status='delivered',receipt=? WHERE id=?").run(receipt,notices[0].id);assert.equal(s.status().lastSourceTelegramReceiptAt,null);}
  s.db.prepare("UPDATE outbox SET status='pending',receipt=? WHERE id=?").run(JSON.stringify({provider:'telegram',messageId:'12',deliveredAt:LATER}),notices[0].id);
  assert.equal(s.status().lastSourceTelegramReceiptAt,null);
 }finally{s.close();}
});

test('latest valid delivery time wins independently of source order; a later invalid record does not hide older evidence',async t=>{
 const {directory,notices}=await seed(t);await acknowledgeDelivery({directory,noticeId:notices[0].id,receipt:{provider:'telegram',messageId:'8',deliveredAt:LATER}});
 await acknowledgeDelivery({directory,noticeId:notices[1].id,receipt:{provider:'telegram',messageId:'9',deliveredAt:EARLY}});
 assert.equal((await readStatus(directory)).lastSourceTelegramReceiptAt,LATER);
 const s=await openStore(directory);s.db.prepare('UPDATE outbox SET receipt=? WHERE id=?').run(JSON.stringify({provider:'telegram',messageId:'10',deliveredAt:new Date(NOW+86400000).toISOString()}),notices[1].id);s.close();
 assert.equal((await readStatus(directory)).lastSourceTelegramReceiptAt,LATER);
});
