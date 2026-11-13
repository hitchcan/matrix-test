import {deepseekSearch} from './deepseek-search.mjs';
import sanitizeHtml from 'sanitize-html';
const fault=code=>Object.assign(Error(code),{code});
const plain=value=>sanitizeHtml(String(value||''),{allowedTags:[],allowedAttributes:{}}).replace(/\s+/g,' ').trim().slice(0,1500);
const host=(href,name)=>{try{const u=new URL(href);return u.protocol==='https:'&&u.hostname===name&&!u.username&&!u.password;}catch{return false;}};
async function limited(response,max){
  if(!response.ok||Number(response.headers.get('content-length'))>max)throw fault('image_search_failed');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>max)throw fault('image_search_failed');chunks.push(chunk);}return Buffer.concat(chunks);
}
export function commonsImages({request=fetch}={}){
  const headers={'User-Agent':'MatrixStudio/0.9 (local content workspace; MediaWiki Action API)'};
  return {async search(queries,{signal,limit=4}={}){
    if(!Array.isArray(queries)||!queries.length||queries.length>2||queries.some(q=>typeof q!=='string'||!q.trim()||q.length>200))throw fault('invalid_image_queries');
    const results=[],seen=new Set();
    for(const query of queries){
      signal?.throwIfAborted();
      const url=new URL('https://commons.wikimedia.org/w/api.php');url.search=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:'6',prop:'imageinfo',iiprop:'url|mime|extmetadata',iiurlwidth:'1200',iiextmetadatafilter:'Artist|LicenseShortName|LicenseUrl|ImageDescription|AttributionRequired|Copyrighted'});
      let payload;try{payload=JSON.parse((await limited(await request(url,{headers,signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),redirect:'error'}),2*1024*1024)).toString());}catch{signal?.throwIfAborted();throw fault('image_search_failed');}
      if(payload.error)throw fault('image_search_failed');
      for(const page of Object.values(payload.query?.pages||{})){
        const info=page.imageinfo?.[0],meta=info?.extmetadata||{},license=plain(meta.LicenseShortName?.value),author=plain(meta.Artist?.value);
        if(!info||!/^image\/(jpeg|png|webp)$/.test(info.mime)||!author||!(/^(CC0|Public domain|PD)$/i.test(license)||/^CC BY [1-4]\.0$/i.test(license)))continue;
        const imageUrl=info.thumburl||info.url,pageUrl=info.descriptionurl;
        if(!host(imageUrl,'upload.wikimedia.org')||!host(pageUrl,'commons.wikimedia.org')||seen.has(pageUrl))continue;
        const licenseUrl=meta.LicenseUrl?.value||'';
        if(/^CC BY/i.test(license)&&!host(licenseUrl,'creativecommons.org'))continue;
        seen.add(pageUrl);results.push({name:plain(page.title).replace(/^File:/,''),imageUrl,pageUrl,author,license,licenseUrl,description:plain(meta.ImageDescription?.value),query,provider:'wikimedia-commons'});
        if(results.length>=limit)return results;
      }
    }
    return results;
  },async download(candidate,{signal}={}){
    if(!host(candidate.imageUrl,'upload.wikimedia.org'))throw fault('image_search_failed');
    const response=await request(candidate.imageUrl,{headers,signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),redirect:'error'});
    const mime=(response.headers.get('content-type')||'').split(';')[0];if(!/^image\/(jpeg|png|webp)$/.test(mime))throw fault('image_search_failed');
    const bytes=await limited(response,10*1024*1024);
    const valid=mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!valid)throw fault('image_search_failed');return {bytes,mime};
  }};
}

function gatewayEndpoint(value){const url=new URL(value);if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw Error('invalid_endpoint');return url;}
export function imageSettings(db,request=fetch){
  db.exec('CREATE TABLE IF NOT EXISTS image_search_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
  const legacy=db.prepare('SELECT value FROM image_search_settings WHERE id=1').get();
  if(legacy&&JSON.parse(legacy.value).provider==='commons')db.prepare('UPDATE image_search_settings SET value=? WHERE id=1').run(JSON.stringify({provider:'deepseek',endpoint:'https://api.deepseek.com/v1/tools/search',key:'',downloadHosts:'',sites:''}));
  const get=()=>{const row=db.prepare('SELECT value FROM image_search_settings WHERE id=1').get();return row?JSON.parse(row.value):{provider:'deepseek',endpoint:'https://api.deepseek.com/v1/tools/search',key:'',downloadHosts:'',sites:''};};
  const view=()=>{const {key,...rest}=get();return {...rest,hasKey:!!key,configured:rest.provider!=='deepseek'||!!key};};
  function save(input){
    const fail=()=>{throw Object.assign(Error('检索配置无效：请使用HTTPS或本机HTTP；DeepSeek地址需以/v1/tools/search结尾，JSON图片网关需填写允许下载的主机名'),{status:422});};
    if(!input||!['deepseek','json'].includes(input.provider)||['endpoint','key','downloadHosts','sites'].some(k=>input[k]!==undefined&&(typeof input[k]!=='string'||input[k].length>4096))||(input.clearKey!==undefined&&typeof input.clearKey!=='boolean'))return fail();
    const prior=get(),endpoint=input.endpoint?.trim()||(input.provider==='deepseek'?'https://api.deepseek.com/v1/tools/search':''),downloadHosts=input.downloadHosts?.trim()||'';
    if(input.provider==='json'){try{gatewayEndpoint(endpoint);}catch{return fail();}if(!downloadHosts||downloadHosts.split(',').some(h=>!/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(h.trim())))return fail();}
    const sites=input.sites?.trim()||'';if(sites&&(sites.split(',').length>3||sites.split(',').some(s=>!/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(s.trim()))))return fail();
    if(input.provider==='deepseek'){try{const u=gatewayEndpoint(endpoint);if(!/\/v1\/tools\/search\/?$/.test(u.pathname))return fail();}catch{return fail();}}
    const value={provider:input.provider,endpoint,downloadHosts,sites,key:input.clearKey?'':input.key||(prior.endpoint===endpoint&&prior.provider===input.provider?prior.key:'')};
    db.prepare('INSERT OR REPLACE INTO image_search_settings VALUES(1,?)').run(JSON.stringify(value));return view();
  }
  function capture(){
    const p=get();if(p.provider==='deepseek')return deepseekSearch({endpoint:p.endpoint,key:p.key,sites:(p.sites||'').split(',').map(s=>s.trim()).filter(Boolean),request});
    const allowed=p.downloadHosts.split(',').map(h=>h.trim()),base=gatewayEndpoint(p.endpoint);
    return {async search(queries,{signal,limit=4}={}){
      if(!Array.isArray(queries)||!queries.length||queries.length>2||queries.some(q=>typeof q!=='string'||!q.trim()||q.length>200))throw fault('invalid_image_queries');
      const response=await request(base,{method:'POST',headers:{'Content-Type':'application/json',...(p.key?{Authorization:'Bearer '+p.key}:{})},body:JSON.stringify({queries,limit}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),redirect:'error'});
      const payload=JSON.parse((await limited(response,2*1024*1024)).toString());
      if(!Array.isArray(payload.images))throw fault('image_search_failed');
      const seen=new Set();return payload.images.slice(0,20).flatMap(image=>{
        try{const page=new URL(image.pageUrl),url=new URL(image.imageUrl),license=plain(image.license),author=plain(image.author);if(!author||!(/^(CC0|Public domain|PD)$/i.test(license)||/^CC BY [1-4]\.0$/i.test(license))||url.protocol!=='https:'||url.username||url.password||!allowed.includes(url.hostname)||page.protocol!=='https:'||page.username||page.password||seen.has(page.href)||(/^CC BY/i.test(license)&&!host(image.licenseUrl,'creativecommons.org')))return [];seen.add(page.href);return [{provider:'configured-gateway',name:plain(image.name)||'检索配图',description:plain(image.description),author,license,licenseUrl:image.licenseUrl||'',pageUrl:page.href,imageUrl:url.href,query:queries.join(' / ')}];}catch{return [];}
      }).slice(0,limit);
    },async download(candidate,{signal}={}){
      let url;try{url=new URL(candidate.imageUrl);}catch{throw fault('image_search_failed');}if(url.protocol!=='https:'||url.username||url.password||!allowed.includes(url.hostname))throw fault('image_search_failed');
      const response=await request(url,{signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),redirect:'error'}),mime=(response.headers.get('content-type')||'').split(';')[0];if(!/^image\/(jpeg|png|webp)$/.test(mime))throw fault('image_search_failed');
      const bytes=await limited(response,10*1024*1024);const valid=mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!valid)throw fault('image_search_failed');return {bytes,mime};
    }};
  }
  return {view,save,capture};
}
