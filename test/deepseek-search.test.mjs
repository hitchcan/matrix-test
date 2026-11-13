import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {deepseekSearch,markdownImages} from '../workflow/deepseek-search.mjs';
import {publicAddress,downloadPublicImage} from '../workflow/public-image.mjs';
import {imageSettings} from '../workflow/image-search.mjs';
import {createStudio} from '../server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64');
const wait=async fn=>{for(let i=0;i<600;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('等待国内检索工作流超时');};
async function setup(t,options={}){const dir=mkdtempSync(join(tmpdir(),'matrix-deepseek-'));let studio,base,token;const start=async()=>{studio=createStudio({dataDir:dir,tickMs:8,demoDelay:8,...options});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+studio.server.address().port;token=(await fetch(base+'/api/state').then(r=>r.json())).token;};await start();t.after(async()=>{await studio.close();const path=resolve(dir);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith('matrix-deepseek-'));rmSync(path,{recursive:true,force:true});});const api=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};return {api,get base(){return base;},get studio(){return studio;},restart:async()=>{await studio.close();await start();}};}
const page={title:'本地项目发布说明',url:'https://www.gov.cn/example/report',site_name:'来源网站',date:'2026-11-12T00:00:00Z',summary:'新增了图文能力。',content:'项目新增图文能力。'};
const spec={topic:'图文工作流',style:'事实清楚、短段落',facts:'',webResearch:true,reviewBeforePublish:true,assetIds:[],targets:[{accountId:'demo-zhihu',type:'article'}],mode:'auto',maxCalls:4,maxSearchRequests:4};

test('DeepSeek 原生请求、中文限定、网页抓取与真实图片提取，不伪造作者许可',async()=>{
  const calls=[];let reserved=0;const provider=deepseekSearch({key:'search-private',sites:['gov.cn'],request:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(String(url).endsWith('/search')?{results:[{...page,content:''}]}:{title:page.title,content:'正文\n![项目配图](https://images.example.cn/photo.jpg)\n![logo](https://images.example.cn/logo.png)\n![私网](http://127.0.0.1/private.png)'}));}});
  const result=await provider.research(['图文项目'],{images:true,limit:1,signal:AbortSignal.timeout(2000),reserveCall:()=>reserved++});
  assert.equal(reserved,2);assert.equal(calls[0].url,'https://api.deepseek.com/v1/tools/search');assert.deepEqual(JSON.parse(calls[0].options.body),{query:'图文项目 lang:zh site:gov.cn',count:3,need_content:true});assert.equal(calls[0].options.headers.Authorization,'Bearer search-private');assert.equal(calls[1].url,'https://api.deepseek.com/v1/tools/fetch');assert.deepEqual(JSON.parse(calls[1].options.body),{url:page.url});assert.equal(result.sources[0].date,page.date);assert.equal(result.images.length,1);assert.equal(result.images[0].license,'使用许可未核验');assert.equal(result.images[0].pageUrl,page.url);assert.match(result.images[0].author,/未核验/);
});

test('默认服务与旧Commons配置迁移为DeepSeek，自有网关保留；密钥不回传或跨接口继承',()=>{
  const db=new DatabaseSync(':memory:');try{let settings=imageSettings(db);assert.equal(settings.view().provider,'deepseek');assert.equal(settings.view().configured,false);db.prepare('INSERT INTO image_search_settings VALUES(1,?)').run(JSON.stringify({provider:'commons',endpoint:'',key:'old-unused-secret',downloadHosts:''}));settings=imageSettings(db);assert.equal(settings.view().provider,'deepseek');assert.equal(settings.view().hasKey,false);const saved=settings.save({provider:'deepseek',key:'private-deepseek',sites:'gov.cn,news.cn'});assert.equal(saved.hasKey,true);assert.ok(!JSON.stringify(saved).includes('private-deepseek'));settings.save({provider:'deepseek',endpoint:'https://other.example/v1/tools/search',key:'',sites:''});assert.equal(settings.view().hasKey,false);settings.save({provider:'json',endpoint:'https://images.example/search',downloadHosts:'images.example',key:'gateway-private'});assert.equal(imageSettings(db).view().provider,'json');}finally{db.close();}
});

test('请求次数上限在发请求前生效；鉴权、余额和来源过滤明确失败，不偷偷重试',async()=>{
  let requests=0,count=0;const provider=deepseekSearch({key:'key',request:async url=>{requests++;return new Response(JSON.stringify(String(url).endsWith('/search')?{results:[{...page,content:''},{...page,url:'https://www.gov.cn/second',content:''}]}:{content:'无图片'}));}});
  await assert.rejects(provider.research(['主题'],{images:true,signal:AbortSignal.timeout(2000),reserveCall:()=>{if(count>=2)throw Object.assign(Error('search_request_limit'),{code:'search_request_limit'});count++;}}),e=>e.code==='search_request_limit');assert.equal(requests,2);assert.equal(count,2);
  for(const [status,code] of [[401,'search_auth_failed'],[402,'search_balance_required'],[429,'search_rate_limited']]){let calls=0;const p=deepseekSearch({key:'key',request:async()=>{calls++;return new Response('{}',{status});}});await assert.rejects(p.research(['主题'],{signal:AbortSignal.timeout(2000)}),e=>e.code===code);assert.equal(calls,1);}
  const restricted=deepseekSearch({key:'key',sites:['gov.cn'],request:async()=>new Response(JSON.stringify({results:[{...page,url:'https://outside.example/article'}]}))});await assert.rejects(restricted.research(['主题'],{signal:AbortSignal.timeout(2000)}),e=>e.code==='domestic_search_empty');
});

test('公开图片下载固定DNS解析，不携带API密钥，拒绝私网、混合DNS和重定向',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','::1','0:0:0:0:0:0:0:1','fc00::1','fe80::1','::ffff:127.0.0.1','64:ff9b::7f00:1'])assert.equal(publicAddress(ip),false,ip);
  let resolves=0,lookups=0;const candidate={imageUrl:'https://images.example.cn/photo.png'};
  const result=await downloadPublicImage(candidate,{signal:AbortSignal.timeout(2000),lookup:async()=>{resolves++;return [{address:'93.184.216.34',family:4}];},transport:(url,options,callback)=>{assert.equal(options.headers.Authorization,undefined);options.lookup(url.hostname,{all:true},(error,addresses)=>{assert.equal(error,null);assert.equal(addresses[0].address,'93.184.216.34');lookups++;});const req=new EventEmitter();req.end=()=>{const response=Readable.from([png]);response.statusCode=200;response.headers={'content-type':'image/png'};callback(response);};return req;}});assert.deepEqual(result.bytes,png);assert.equal(resolves,1);assert.equal(lookups,1);
  await assert.rejects(downloadPublicImage(candidate,{signal:AbortSignal.timeout(2000),lookup:async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]}),/unsafe_public_address/);
  assert.equal(markdownImages('![坏图](file:///c:/private)\n![图片](https://10.0.0.1/x)',{url:page.url,title:'主题'}).length,0);
});

test('真实HTTP检索资料交给主agent，出处写入成稿并经编辑、重启及确认发布保留',async t=>{
  let searches=0,modelCalls=0;const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/tools/search'){searches++;assert.equal(req.headers.authorization,'Bearer retrieval-private');assert.match(body.query,/lang:zh/);res.end(JSON.stringify({results:[page]}));return;}
    modelCalls++;assert.equal(req.headers.authorization,'Bearer agent-private');const content=body.messages[1].content,input=JSON.parse(Array.isArray(content)?content[0].text:content);let output;
    if(body.messages[0].content.includes('检索规划员'))output={queries:['项目图文功能'],visualSummary:''};else{assert.equal(input.researchSources[0].url,page.url);output={title:'依据来源的报道',body:'本地项目新增图文能力。',assetIds:[],blocks:[{type:'paragraph',text:'本地项目新增图文能力。'}],reviewNotes:'按用户意见整理。'};}
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const app=await setup(t),base='http://127.0.0.1:'+server.address().port;await app.api('model-settings',{endpoint:base+'/chat',model:'agent',key:'agent-private'});await app.api('image-settings',{provider:'deepseek',endpoint:base+'/v1/tools/search',key:'retrieval-private'});
  const template=await app.api('task-templates',{enabled:true,spec}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'retrieved-news'});let detail=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='awaiting_review'&&r;});let target=detail.targets[0];assert.equal(target.search_calls,1);assert.equal(detail.calls,2);assert.equal(searches,1);assert.match(target.artifact.body,/参考资料.*gov.cn/);assert.equal(target.research_sources[0].date,page.date);assert.equal(target.artifact.researchSources[0].url,page.url);assert.ok(!JSON.stringify(detail).includes('retrieval-private'));
  const edited=await app.api(`runs/${run.id}/targets/${target.id}/edit`,{expectedRevision:target.revision,title:'编辑后的报道',blocks:target.artifact.blocks});target=edited.targets[0];assert.match(target.artifact.body,/gov.cn/);
  await app.api(`runs/${run.id}/targets/${target.id}/revise`,{expectedRevision:target.revision,feedback:'保持简洁'});detail=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='awaiting_review'&&r.targets[0].revision>target.revision&&r;});target=detail.targets[0];assert.equal(searches,1);assert.equal(modelCalls,3);assert.match(target.artifact.body,/gov.cn/);
  await app.restart();assert.equal((await app.api('runs/'+run.id)).targets[0].search_calls,1);await app.api(`runs/${run.id}/targets/${target.id}/approve`,{expectedRevision:target.revision});await wait(async()=>(await app.api('state')).jobs.some(j=>j.state==='demo_submitted'));assert.match((await app.api('state')).jobs[0].content.body,/gov.cn/);
});

test('检索密钥缺失在LLM调用前阻断，界面默认DeepSeek并保存中文检索任务',async t=>{
  let writes=0;const app=await setup(t,{writer:async()=>{writes++;return {title:'不能调用',body:'正文',assetIds:[]};}});const template=await app.api('task-templates',{enabled:true,spec}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'missing-key'});const detail=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].reason==='missing_search_key'&&r;});assert.equal(writes,0);assert.equal(detail.calls,0);assert.equal(detail.targets[0].search_calls,0);
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(6000);const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(app.base+'/#macros');await p.locator('.task-image-config summary').click();const config=p.locator('#image-config-form');assert.equal(await config.locator('[name=provider]').inputValue(),'deepseek');assert.equal(await config.locator('[name=endpoint]').inputValue(),'https://api.deepseek.com/v1/tools/search');await config.locator('[name=key]').fill('ui-search-private');await config.locator('[name=sites]').fill('gov.cn,news.cn');await config.getByRole('button',{name:'保存检索配置',exact:true}).click();await p.locator('#image-config-status').filter({hasText:'检索配置已保存'}).waitFor();assert.ok(!JSON.stringify(await app.api('state')).includes('ui-search-private'));
  const form=p.locator('#macro-form');await form.locator('[name=topic]').fill('国内项目资料');await form.locator('[name=style]').fill('清楚简短');await form.locator('[name=webResearch]').check();await form.locator('[name=maxSearchRequests]').selectOption('3');await form.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();await form.getByRole('button',{name:'保存任务',exact:true}).click();await wait(async()=>(await app.api('task-templates')).length===2);const saved=(await app.api('task-templates'))[0];assert.equal(saved.spec.webResearch,true);assert.equal(saved.spec.maxSearchRequests,3);
  await p.locator('.task-image-config summary').click();await p.locator('.task-image-config').scrollIntoViewIfNeeded();await p.screenshot({path:'.data/deepseek-search-config-preview.png'});await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
