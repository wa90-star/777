import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function decode(value='') {
 return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|rsquo|lsquo);/gi,(_,x)=>{
  if(x[0]==='#'){const n=x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'�';}
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘'}[x.toLowerCase()];
 });
}
export function plain(value='') {return decode(String(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
export function canonicalUrl(value,base) {
 const u=new URL(decode(value),base);
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Unsafe article URL');
 u.protocol='https:';u.hash='';
 for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid|trk)$/i.test(k))u.searchParams.delete(k);
 u.searchParams.sort();return u.href;
}
export const eventId = item => item.nativeId ? `sec:1385849:${item.nativeId}` : `url:${digest(item.url)}`;
export function attributes(tag) {
 const a={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))a[m[1].toLowerCase()]=decode(m[2]??m[3]);return a;
}
export function anchors(html,base,accept) {
 const out=new Map();
 for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
  const a=attributes(m[1]);if(!a.href)continue;
  let url;try{url=canonicalUrl(a.href,base);}catch{continue;}
  if(new URL(url).hostname!==new URL(base).hostname||!accept(new URL(url)))continue;
  const title=plain(a.title||m[2]);if(title.length<8||/^(Read Article|Full Text|Learn More|Image:)/i.test(title))continue;
  if(!out.has(url))out.set(url,{url,title,summary:'',publishedAt:null,publishedRaw:null});
 }
 return [...out.values()];
}
// Deliberately limited HTML selector: class on a known element, with nested element accounting.
// Never evaluates site scripts. Missing/changed markup fails the source rather than returning "no news".
export function classBody(html,className) {
 const tags=/<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
 let start=-1,kind,depth=0;
 for(const m of html.matchAll(tags)){
  const closing=m[0].startsWith('</');
  if(start<0){if(!closing&&(attributes(m[0]).class||'').split(/\s+/).includes(className)){start=m.index+m[0].length;kind=m[1].toLowerCase();depth=1;}}
  else if(m[1].toLowerCase()===kind){depth+=closing?-1:1;if(!depth)return html.slice(start,m.index);}
 }
 throw new Error(`Required article/list block absent: ${className}`);
}
export function parseRss(html,source) {
 if(!/<rss\b/i.test(html)||!/<\/rss\s*>/i.test(html)||/<!DOCTYPE|<!ENTITY/i.test(html))throw new Error('Unsupported or malformed RSS');
 const chunks=[...html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)];
 if(chunks.length!==(html.match(/<item\b/gi)||[]).length)throw new Error('Truncated RSS items');
 const tag=(xml,name)=>decode(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`,'i'))?.[1]||'').trim();
 return chunks.map(([,xml])=>{
  const url=canonicalUrl(tag(xml,'link'),source.url),title=plain(tag(xml,'title'));
  if(!title||!tag(xml,'link'))throw new Error('RSS item lacks title/link');
  const raw=tag(xml,'pubDate')||null;
  return {url,title,summary:plain(tag(xml,'description')),publishedRaw:raw,publishedAt:raw&&!Number.isNaN(Date.parse(raw))?new Date(raw).toISOString():null};
 });
}
export function parseSec(text) {
 const data=JSON.parse(text),r=data?.filings?.recent;
 if(Number(data.cik)!==1385849||!r||!Array.isArray(r.accessionNumber))throw new Error('Wrong issuer or SEC schema');
 for(const key of ['form','filingDate','primaryDocument','acceptanceDateTime'])if(!Array.isArray(r[key])||r[key].length!==r.accessionNumber.length)throw new Error('Incomplete SEC column arrays');
 return r.accessionNumber.map((id,i)=>{
  if(!/^\d{10}-\d{2}-\d{6}$/.test(id)||!r.primaryDocument[i]||!r.form[i])throw new Error('Invalid SEC accession/document');
  const raw=r.acceptanceDateTime[i]||null;
  return {nativeId:id,url:`https://www.sec.gov/Archives/edgar/data/1385849/${id.replaceAll('-','')}/${encodeURIComponent(r.primaryDocument[i])}`,title:`Energy Fuels: ${r.form[i]} (${r.filingDate[i]})`,summary:plain(r.primaryDocDescription?.[i]||''),form:r.form[i],publishedRaw:raw,publishedAt:raw&&!Number.isNaN(Date.parse(raw))?new Date(raw).toISOString():null};
 });
}
export function mofcomUnitUrl(html,source) {
 const script=[...html.matchAll(/<script\b[^>]*>/gi)].map(m=>attributes(m[0])).find(a=>a.querydata&&a.url==='/api-gateway/jpaas-publish-server/front/page/build/unit');
 if(!script)throw new Error('MOFCOM list query absent');
 const data=JSON.parse(script.querydata.replaceAll("'",'"'));
 const allowed=['parseType','webId','tplSetId','pageType','tagId','editType','pageId'];
 if(Object.keys(data).some(k=>!allowed.includes(k))||data.pageType!=='column')throw new Error('Unexpected MOFCOM query');
 return new URL(script.url,source.url).href+'?'+new URLSearchParams(data);
}
export function parseListing(text,source) {
 if(source.kind==='rss')return parseRss(text,source);
 if(source.kind==='sec')return parseSec(text);
 if(source.kind==='mofcom'){
  const data=JSON.parse(text);if(data.success!==true||typeof data.data?.html!=='string')throw new Error('MOFCOM unsuccessful response');
  const html=data.data.html,items=[];
  for(const [,li]of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)){
   const item=anchors(li,source.url,u=>/\/art\/\d{4}\/art_[a-f0-9]+\.html$/.test(u.pathname))[0];
   if(item){const raw=plain(li).match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);if(raw)item.publishedRaw=`${raw[3]}-${raw[1]}-${raw[2]}`;items.push(item);}
  }return items;
 }
 if(source.kind==='ef-html'){
  const chunks=text.split(/<div class="wd_item_wrapper">/).slice(1);
  return chunks.map(chunk=>{
   const item=anchors(chunk.split('<div class="wd_toolbar')[0],source.url,u=>/^\/\d{4}-\d{2}-\d{2}-/.test(u.pathname))[0];
   if(!item)throw new Error('Energy Fuels release block lacks article');
   item.publishedRaw=plain(chunk.match(/<div class="wd_date">([\s\S]*?)<\/div>/)?.[1]||'')||null;
   item.summary=plain(chunk.match(/<div class="wd_summary">([\s\S]*?)<\/div>/)?.[1]||'');return item;
  });
 }
 if(source.kind==='doe-html')return anchors(text,source.url,u=>/^\/(?:[a-z-]+\/)?articles\//.test(u.pathname));
 if(source.kind==='usgs-html')return anchors(text,source.url,u=>/^\/news\/(?:national-news-release|science-snippet|technical-announcement)\//.test(u.pathname)||/^\/programs\/mineral-resources-program\/news\//.test(u.pathname));
 throw new Error('Unknown source parser');
}
export function classify(item,source) {
 const text=[item.title,item.summary,item.bodyText||''].join(' ');
 const topics=[];
 for(const [name,re]of Object.entries({company:/\b(?:Energy Fuels|UUUU|White Mesa|Pinyon Plain|Toliara|Vara Mada|Donald project)\b/i,nuclear:/\b(?:uranium|nuclear|reactor|HALEU|enrichment|fuel cycle)\b/i,rare_earths:/\b(?:rare[- ]earth|critical mineral|critical material|magnet|dysprosium|terbium|monazite|neodymium)\b/i,policy:/\b(?:export control|export licen[cs]|tariff|sanction|Defense Production Act)\b/i,demand:/\b(?:data cent(?:er|re)|power purchase|PPA|electricity demand)\b/i}))if(re.test(text))topics.push(name);
 const riskTerms=/\b(?:halt|suspend|delay|cancel|terminate|default|impairment|dilution|injunction|ban|revok|cut|dispute|litigation|shortfall)\w*\b/i.test(text);
 return {queue:source.direct||topics.length?'REVIEW':'UNCLASSIFIED_REVIEW',topics,riskTermsPresent:riskTerms,efImpact:'UNASSESSED',economicMateriality:'UNASSESSED',tradePermission:false};
}
