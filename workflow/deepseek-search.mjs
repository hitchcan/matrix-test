import sanitizeHtml from 'sanitize-html';
import {publicUrl,downloadPublicImage} from './public-image.mjs';
const fault=code=>Object.assign(Error(code),{code});
const text=(value,max=6000)=>sanitizeHtml(String(value||''),{allowedTags:[],allowedAttributes:{}}).trim().slice(0,max);
export function markdownImages(content,page){
  const result=[],seen=new Set(),patterns=[/!\[([^\]\n]{0,300})\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\s*\)/g,/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi];
  for(const [index,pattern] of patterns.entries())for(const match of String(content||'').matchAll(pattern)){
    try{const caption=index===0?text(match[1],300):'',href=index===0?match[2]:match[1],imageUrl=publicUrl(new URL(href,page.url).href).href;if(/favicon|\bicon\b|logo|\.svg(?:\?|$)|\.ico(?:\?|$)/i.test(imageUrl+' '+caption)||seen.has(imageUrl))continue;seen.add(imageUrl);result.push({provider:'deepseek-search',name:caption||page.title||'网页资料图',imageUrl,pageUrl:page.url,author:'作者未核验（网页来源：'+(page.siteName||new URL(page.url).hostname)+'）',license:'使用许可未核验',licenseUrl:'',description:caption||page.title,query:page.query});if(result.length>=4)return result;}catch{}
  }
  return result;
}
export function deepseekSearch({endpoint='https://api.deepseek.com/v1/tools/search',key='',sites=[],request=fetch,download=downloadPublicImage}={}){
  const base=new URL(endpoint),fetchUrl=new URL(base.href.replace(/\/search\/?$/,'/fetch'));
  async function post(url,body,options){
    if(!key)throw fault('missing_search_key');options.signal?.throwIfAborted();options.reserveCall?.();
    let response;try{response=await request(url,{method:'POST',redirect:'error',signal:AbortSignal.any([options.signal||new AbortController().signal,AbortSignal.timeout(30000)]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)});}catch{options.signal?.throwIfAborted();throw fault('domestic_search_failed');}
    if(!response.ok)throw fault(response.status===401?'search_auth_failed':response.status===402?'search_balance_required':response.status===429?'search_rate_limited':'domestic_search_failed');
    if(Number(response.headers.get('content-length'))>4*1024*1024)throw fault('domestic_search_failed');
    let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>4*1024*1024)throw fault('domestic_search_failed');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw fault('domestic_search_failed');}
  }
  const service={async research(queries,options={}){
    if(!Array.isArray(queries)||!queries.length||queries.length>2||queries.some(q=>typeof q!=='string'||!q.trim()||[...q].length>128))throw fault('invalid_image_queries');
    const sources=[],images=[],seen=new Set();let fetched=0;
    for(const original of queries){
      const query=original.trim()+' lang:zh'+(sites.length?' '+sites.map(s=>'site:'+s).join(' OR '):'');if([...query].length>128)throw fault('search_query_too_long');
      const payload=await post(base,{query,count:3,need_content:true},options);
      if(!Array.isArray(payload.results))throw fault('domestic_search_failed');
      for(const item of payload.results.slice(0,3)){
        let url;try{url=publicUrl(item.url).href;}catch{continue;}if(sites.length&&!sites.some(site=>new URL(url).hostname===site||new URL(url).hostname.endsWith('.'+site)))continue;if(seen.has(url))continue;seen.add(url);
        const page={id:'资料'+(sources.length+1),title:text(item.title,300),url,siteName:text(item.site_name,100),date:typeof item.date==='string'&&Number.isFinite(Date.parse(item.date))?item.date:null,summary:text(item.summary||item.snippet,1500),content:text(item.content,6000),query:original,provider:'deepseek-search',retrievedAt:new Date().toISOString()};
        const content=typeof item.content==='string'?item.content.slice(0,200000):'';let found=options.images?markdownImages(content,page):[];
        if(options.images&&images.length<(options.limit||3)&&!found.length&&fetched<2){
          fetched++;try{const fetchedPage=await post(fetchUrl,{url},options);if(typeof fetchedPage.content==='string'){page.content=text(fetchedPage.content,6000);found=markdownImages(fetchedPage.content.slice(0,200000),page);}}catch(error){if(['missing_search_key','search_auth_failed','search_balance_required','search_rate_limited','search_request_limit'].includes(error.code))throw error;options.signal?.throwIfAborted();}
        }
        sources.push(page);for(const image of found)if(!images.some(i=>i.imageUrl===image.imageUrl)&&images.length<(options.limit||3))images.push(image);
        if(sources.length>=6)break;
      }
      if(sources.length>=6||options.images&&images.length>=(options.limit||3))break;
    }
    if(!sources.length)throw fault('domestic_search_empty');return {sources,images};
  },async search(queries,options){return (await service.research(queries,{...options,images:true})).images;},download};return service;
}
