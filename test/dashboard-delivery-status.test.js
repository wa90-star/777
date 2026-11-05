"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"../public/dashboard-v4.html"),"utf8");
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function render(status={},ef={}) {
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:"",innerHTML:"",className:"",value:"",addEventListener(){}});return elements.get(id);};
 const requests=[];
 const context=vm.createContext({document:{getElementById:element},URL,setInterval:()=>0,fetch:async url=>{
   requests.push(url);return{ok:true,json:async()=>url==="/api/status"?status:url==="/api/ef-primary/status"?ef:{}};
 }});
 vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));
 return {element,context,requests};
}
const confirmed={telegramConfigured:true,deliveryMode:"live",deliveryProbe:{status:"CONFIRMED",providerAcceptedAt:"2026-11-05T20:01:29Z",messageId:108},telegramDelivery:{lastSuccessAt:null,lastError:null}};
test("persisted successful probe remains confirmed after transport-state reset",async()=>{
 const ui=await render(confirmed);assert.equal(ui.element("telegram").textContent,"Test bestätigt");
 assert.match(ui.element("telegramDetail").textContent,/05\.11\.2026/);assert.match(ui.element("telegramDetail").textContent,/Fachliche Zustellbelege.*separat/);
 assert.doesNotMatch(ui.element("telegram").textContent,/ungetestet|Zustellung/);
 assert.ok(ui.requests.every(url=>url.startsWith("/api/")));
});
test("historic alert and EF source times show date and explicit Berlin zone",async()=>{
 const ui=await render({...confirmed,lastAlertAt:"2026-10-04T12:05:00Z"},{enabled:true,configured:true,intervalMinutes:10,lastCollectionAt:"2026-11-05T20:00:00Z",status:{sources:{sec:{status:"OK",lastSuccessAt:"2026-10-04T12:05:00Z"}}}});
 assert.match(ui.element("lastAlert").textContent,/04\.10\.2026/);assert.match(ui.element("lastAlert").textContent,/14:05/);
 assert.match(ui.element("efSummary").textContent,/05\.11\.2026/);assert.match(ui.element("efSources").innerHTML,/04\.10\.2026/);
 assert.match(html,/Inklusive gespeicherter Historie; kein Zustellbeleg/);
});
test("a current delivery error remains visible despite the historical successful probe",async()=>{
 const ui=await render({...confirmed,telegramDelivery:{lastError:"provider failure"}});
 assert.equal(ui.element("telegram").textContent,"Zustellfehler");assert.match(ui.element("telegramDetail").textContent,/Gespeicherter Verbindungstest/);
});
test("probe-only mode is explicit even after a successful test",async()=>{
 const ui=await render({...confirmed,deliveryMode:"probe-only",telegramConfigured:false,telegramCredentialsConfigured:true});assert.equal(ui.element("telegram").textContent,"Test bestätigt");
 assert.match(ui.element("telegramDetail").textContent,/Fachlicher Versand ist pausiert/);
});
test("generic transport acceptance is not represented as a confirmed subject alert",async()=>{
 const ui=await render({telegramConfigured:true,telegramDelivery:{lastSuccessAt:"2026-11-05T20:01:29Z"}});
 assert.equal(ui.element("telegram").textContent,"Anbieterannahme bestätigt");assert.match(ui.element("telegramDetail").textContent,/kann den Verbindungstest einschließen/);
});
test("invalid stored test receipt does not claim confirmation",async()=>{
 const ui=await render({...confirmed,deliveryProbe:{status:"CONFIRMED",providerAcceptedAt:"invalid",messageId:108}});
 assert.equal(ui.element("telegram").textContent,"Konfiguriert · kein Testbeleg");
});
