import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createStudio} from '../server.mjs';
import {reportContent} from '../workflow/report-content.mjs';
import {commonsImages} from '../workflow/image-search.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64');
const wait=async fn=>{for(let i=0;i<600;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('等待审稿任务超时');};
async function setup(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'matrix-editorial-'));let studio,base,token;
  const start=async()=>{studio=createStudio({dataDir:dir,tickMs:8,demoDelay:8,...options});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+studio.server.address().port;token=(await fetch(base+'/api/state').then(r=>r.json())).token;};await start();
  t.after(async()=>{await studio.close();const path=resolve(dir);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith('matrix-editorial-'));rmSync(path,{recursive:true,force:true});});
  const request=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const api=async(path,body)=>{const r=await request(path,body);assert.ok(r.status<300,JSON.stringify(r.body));return r.body;};
  return {api,request,get base(){return base;},get studio(){return studio;},restart:async()=>{await studio.close();await start();},upload:async()=>{const r=await fetch(base+'/api/assets',{method:'POST',headers:{'X-Studio-Token':token,'Content-Type':'image/png','X-File-Name':encodeURIComponent('原始图片.png')},body:png});assert.equal(r.status,201);return (await r.json()).id;}};
}
const spec={topic:'项目观察',style:'清楚克制的新闻报道风格，适合知乎',facts:'项目支持本地运行，今天增加图片说明。',assetIds:[],targets:[{accountId:'demo-zhihu',type:'article'}],mode:'auto',maxCalls:5,reviewBeforePublish:true};
const candidate={name:'资料图片.png',imageUrl:'https://upload.wikimedia.org/wikipedia/commons/a/aa/Example.png',pageUrl:'https://commons.wikimedia.org/wiki/File:Example.png',author:'Photo Author',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',description:'A computer on a desk',query:'computer desk'};
async function modelServer(t,handler){const calls=[];const server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);calls.push(body);await handler(body,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {calls,endpoint:'http://127.0.0.1:'+server.address().port+'/chat'};}
const reply=(res,output)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));};
const observation=body=>{const value=body.messages[1].content;return JSON.parse(Array.isArray(value)?value[0].text:value);};

test('报道块验证、段落中插图、来源署名不可被模型删除及HTML转义',()=>{
  const assets=[{id:'pic',mime:'image/png',source:candidate}];
  const output=reportContent({title:'报道',blocks:[{type:'paragraph',text:'导语 <script>x</script>'},{type:'image',assetId:'pic',caption:'工作场景'},{type:'paragraph',text:'后续说明'}]},assets,{requireImages:true});
  assert.match(output.bodyHtml,/&lt;script&gt;/);assert.ok(output.bodyHtml.indexOf('导语')<output.bodyHtml.indexOf('<img'));assert.ok(output.bodyHtml.indexOf('<img')<output.bodyHtml.indexOf('后续说明'));assert.match(output.body,/Photo Author.*CC BY 4.0.*creativecommons.*commons/);assert.match(output.body,/非本次事件现场/);
  assert.throws(()=>reportContent({title:'非法',blocks:[{type:'image',assetId:'outside'}]},assets),/配图/);assert.throws(()=>reportContent({title:'无图',blocks:[{type:'paragraph',text:'正文'}]},assets,{requireImages:true}),/报道/);
});

test('Commons仅使用明确许可与固定图片主机，剥离远程HTML，拒绝任意URL下载',async()=>{
  let requests=0;const provider=commonsImages({request:async(url,options)=>{requests++;assert.equal(new URL(url).hostname,'commons.wikimedia.org');assert.ok(options.headers['User-Agent']);const info=license=>({title:'File:Photo.png',imageinfo:[{mime:'image/png',thumburl:candidate.imageUrl,descriptionurl:candidate.pageUrl,extmetadata:{Artist:{value:'<b>Photographer</b><script>alert(1)</script>'},LicenseShortName:{value:license},LicenseUrl:{value:candidate.licenseUrl},ImageDescription:{value:'A desk'}}}]});return new Response(JSON.stringify({query:{pages:{one:info('CC BY-SA 4.0'),two:info('CC BY 4.0')}}}),{headers:{'Content-Type':'application/json'}});}});
  const results=await provider.search(['computer'],{signal:AbortSignal.timeout(2000),limit:2});assert.equal(results.length,1);assert.equal(results[0].author,'Photographer');await assert.rejects(provider.download({...candidate,imageUrl:'http://127.0.0.1/private'},{signal:AbortSignal.timeout(2000)}));assert.equal(requests,1);
});

test('外接初稿经主agent审改和主题检索，保留初稿、编辑历史、追加审改与确认后分发',async t=>{
  let reviewCount=0,searches=0;
  const remote=await modelServer(t,(body,res)=>{
    const input=observation(body),system=body.messages[0].content;
    if(system.includes('检索规划员'))return reply(res,{queries:['computer desk'],visualSummary:''});
    if(system.includes('内容规划 agent'))return reply(res,{prompt:'依据本地事实写图文初稿，不夸大结论'});
    if(body.model==='writer')return reply(res,{title:'夸张的初稿标题',body:'初稿内容需要调整。',assetIds:input.assets.map(a=>a.id)});
    reviewCount++;assert.ok(input.draft);const image=input.assets[0].id;
    return reply(res,{title:reviewCount===1?'平台审改标题':'按意见缩短后的标题',body:'受控正文',assetIds:[image],blocks:[{type:'paragraph',text:'项目支持本地运行。'},{type:'image',assetId:image,caption:'电脑资料图'},{type:'paragraph',text:'新增了图片说明。'}],reviewNotes:reviewCount===1?'删除夸张标题，按事实重组段落并安排配图。':'按用户意见缩短标题。'});
  });
  const app=await setup(t,{imageProvider:{search:async queries=>{searches++;assert.deepEqual(queries,['computer desk']);return [candidate];},download:async()=>({bytes:png,mime:'image/png'})}});
  await app.api('model-settings',{endpoint:remote.endpoint,model:'agent'});const writer=(await app.api('model-settings',{create:true,activate:false,endpoint:remote.endpoint,model:'writer'})).savedId;
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,generationModelId:writer,imageSearch:{enabled:true,useReferenceImages:false,maxImages:1}}});
  const run=await app.api('task-templates/'+template.id+'/run',{requestKey:'report'});let detail=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='awaiting_review'&&r;});let target=detail.targets[0];
  assert.equal(remote.calls.length,4);assert.equal(searches,1);assert.equal(detail.calls,4);assert.equal(target.draft.title,'夸张的初稿标题');assert.equal(target.artifact.title,'平台审改标题');assert.equal(target.artifact.blocks[1].type,'image');assert.equal((await app.api('state')).jobs.length,0);
  const image=target.artifact.assetIds[0],asset=(await app.api('state')).assets.find(a=>a.id===image);assert.equal(asset.source.author,candidate.author);assert.match(target.artifact.body,/CC BY 4.0/);
  const deletion=await fetch(app.base+'/api/assets/'+image,{method:'DELETE',headers:{'X-Studio-Token':(await app.api('state')).token}});assert.equal(deletion.status,409);
  const edited=await app.api(`runs/${run.id}/targets/${target.id}/edit`,{expectedRevision:target.revision,title:'用户修改标题',blocks:target.artifact.blocks});target=edited.targets[0];
  assert.equal((await app.request(`runs/${run.id}/targets/${target.id}/edit`,{expectedRevision:1,title:'旧页面覆盖',blocks:target.artifact.blocks})).status,409);
  const requested=await app.api('agent/actions',{name:'revise_artifact',arguments:{id:run.id,targetId:target.id,expectedRevision:target.revision,feedback:'标题更短'}});assert.ok(requested.ok);
  detail=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='awaiting_review'&&r.targets[0].artifact.title==='按意见缩短后的标题'&&r;});target=detail.targets[0];assert.equal(detail.calls,5);assert.equal(target.versions.length,3);assert.equal(target.draft.title,'夸张的初稿标题');
  await app.restart();const restored=(await app.api('runs/'+run.id)).targets[0];assert.equal(restored.artifact.title,'按意见缩短后的标题');assert.equal(restored.draft.title,'夸张的初稿标题');
  await app.api(`runs/${run.id}/targets/${target.id}/approve`,{expectedRevision:target.revision});await wait(async()=>(await app.api('state')).jobs.find(j=>j.state==='demo_submitted'));
  assert.equal((await app.request(`runs/${run.id}/targets/${target.id}/edit`,{expectedRevision:target.revision+1,title:'已发布后不得偷偷修改',blocks:target.artifact.blocks})).status,409);
  assert.equal((await app.api('state')).jobs[0].content.title,'按意见缩短后的标题');assert.equal(remote.calls.length,5);
});

test('给定图片先交视觉agent规划检索，预算不足时不调用任何模型或检索',async t=>{
  let searches=0,hadImage=false;
  const remote=await modelServer(t,(body,res)=>{
    const input=observation(body);if(body.messages[0].content.includes('检索规划员')){hadImage=body.messages[1].content.some(c=>c.type==='image_url');return reply(res,{queries:['computer desk'],visualSummary:'给定图片中可见一个像素示例'});}
    return reply(res,{title:'资料介绍',body:'正文',assetIds:[input.assets[0].id],blocks:[{type:'paragraph',text:'根据给定资料作介绍'},{type:'image',assetId:input.assets[0].id,caption:'示意图片'}]});
  });
  const app=await setup(t,{imageProvider:{search:async()=>{searches++;return [candidate];},download:async()=>({bytes:png,mime:'image/png'})}});await app.api('model-settings',{endpoint:remote.endpoint,model:'agent',vision:true});const image=await app.upload();
  const make=async maxCalls=>{const saved=await app.api('task-templates',{enabled:true,spec:{...spec,maxCalls,assetIds:[image],imageSearch:{enabled:true,useReferenceImages:true,maxImages:1}}});return app.api('task-templates/'+saved.id+'/run',{requestKey:'vision'});};
  const limited=await make(1);await wait(async()=>(await app.api('runs/'+limited.id)).targets[0].reason==='budget_exhausted');assert.equal(remote.calls.length,0);assert.equal(searches,0);
  const run=await make(2);await wait(async()=>(await app.api('runs/'+run.id)).targets[0].state==='awaiting_review');assert.equal(hadImage,true);assert.equal(searches,1);assert.equal(remote.calls.length,2);
});

test('审稿期间停止使迟到结果失效，外接初稿仍保留且不能发布',async t=>{
  let release,reviewing=false;const remote=await modelServer(t,(body,res)=>{
    if(body.messages[0].content.includes('内容规划 agent'))return reply(res,{prompt:'起草提示'});
    if(body.model==='writer')return reply(res,{title:'原始初稿',body:'给定事实',assetIds:[]});
    reviewing=true;release=()=>reply(res,{title:'迟到审改',body:'给定事实',assetIds:[],reviewNotes:'审改说明'});
  });
  const app=await setup(t);await app.api('model-settings',{endpoint:remote.endpoint,model:'agent'});const writer=(await app.api('model-settings',{create:true,activate:false,endpoint:remote.endpoint,model:'writer'})).savedId;
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,maxCalls:3,generationModelId:writer}}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'stop-review'});await wait(()=>reviewing);await app.api('runs/'+run.id+'/stop',{});release();
  await new Promise(r=>setTimeout(r,60));const detail=await app.api('runs/'+run.id);assert.equal(detail.targets[0].state,'cancelled');assert.equal(detail.targets[0].draft.title,'原始初稿');assert.equal(detail.targets[0].artifact,null);assert.equal((await app.api('state')).jobs.length,0);
});

test('工作台待审图文可编辑段落、图片顺序和标题，确认才发布，窄屏可用',async t=>{
  const app=await setup(t,{writer:async input=>({title:'待审图文',body:'导语\n背景介绍',assetIds:[input.assets[0].id],blocks:[{type:'paragraph',text:'导语'},{type:'image',assetId:input.assets[0].id,caption:'原图说明'},{type:'paragraph',text:'背景介绍'}]})});const image=await app.upload();
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,assetIds:[image]}}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'ui'});await wait(async()=>(await app.api('runs/'+run.id)).targets[0].state==='awaiting_review');
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.base+'/#macros');
  await page.locator('[data-macro-details]').click();await page.locator('[data-edit-artifact]').click();await page.locator('#artifact-editor [name=title]').fill('用户修订后的报道');await page.locator('[data-block-input="0"]').fill('用户修订的导语');await page.locator('[data-move-block="1"][data-offset="1"]').click();assert.equal(await page.locator('.report-block').last().locator('img').count(),1);
  await page.locator('#artifact-editor button[type=submit]').click();await page.locator('#report-edit-status').filter({hasText:'修改已保存'}).waitFor();assert.equal((await app.api('state')).jobs.length,0);
  await page.screenshot({path:'.data/editorial-report-preview.png'});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#report-approve').click();await wait(async()=>(await app.api('state')).jobs.length===1);const artifact=(await app.api('state')).jobs[0].content;assert.equal(artifact.title,'用户修订后的报道');assert.equal(artifact.blocks[2].type,'image');assert.match(artifact.body,/用户修订的导语/);assert.deepEqual(errors,[]);
});

test('可配置图片检索网关仅发送检索词、限制下载主机且不向图片站泄露密钥',async()=>{
  const {DatabaseSync}=await import('node:sqlite'),{imageSettings}=await import('../workflow/image-search.mjs');const db=new DatabaseSync(':memory:');const requests=[];
  try{
    const settings=imageSettings(db,async(url,options)=>{requests.push({url:String(url),options});if(options.method==='POST')return new Response(JSON.stringify({images:[candidate,{...candidate,pageUrl:'https://commons.wikimedia.org/wiki/File:Bad.png',imageUrl:'https://outside.example/file.png'}]}),{headers:{'Content-Type':'application/json'}});return new Response(png,{headers:{'Content-Type':'image/png'}});});
    const saved=settings.save({provider:'json',endpoint:'https://gateway.example/images',key:'image-private',downloadHosts:'upload.wikimedia.org'});assert.equal(saved.hasKey,true);assert.ok(!JSON.stringify(saved).includes('image-private'));
    const provider=settings.capture(),results=await provider.search(['computer desk'],{signal:AbortSignal.timeout(2000),limit:3});assert.equal(results.length,1);assert.deepEqual(JSON.parse(requests[0].options.body),{queries:['computer desk'],limit:3});assert.equal(requests[0].options.headers.Authorization,'Bearer image-private');await provider.download(results[0],{signal:AbortSignal.timeout(2000)});assert.equal(requests[1].options.headers,undefined);
    settings.save({provider:'json',endpoint:'https://other.example/images',key:'',downloadHosts:'upload.wikimedia.org'});assert.equal(settings.view().hasKey,false);
  }finally{db.close();}
});

test('检索失败时明确阻断，不发布缺图稿件且不再触发写作模型',async t=>{
  let searches=0;const remote=await modelServer(t,(body,res)=>reply(res,{queries:['computer'],visualSummary:''}));const app=await setup(t,{imageProvider:{search:async()=>{searches++;return [];}}});await app.api('model-settings',{endpoint:remote.endpoint,model:'agent'});
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,imageSearch:{enabled:true,useReferenceImages:false}}}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'no-image'});await wait(async()=>(await app.api('runs/'+run.id)).targets[0].reason==='image_search_empty');assert.equal(searches,1);assert.equal(remote.calls.length,1);assert.equal((await app.api('state')).jobs.length,0);
});
