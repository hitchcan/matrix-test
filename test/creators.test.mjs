import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {BrowserRuntime,PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
import {createStudio} from '../server.mjs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const douyinHtml=(outcome='success')=>`<!doctype html><meta charset="utf-8"><div class="user-info">抖音号：douyin_video_fixture</div>
<input type="file" accept="video/mp4,video/*" onchange="uploaded()">
<section id="editor" hidden><input placeholder="填写作品标题，为作品获得更多流量"><div class="notranslate" contenteditable="true" data-placeholder="添加作品简介"></div>
<button aria-expanded="false" id="advanced" onclick="document.querySelector('#settings').hidden=false;this.setAttribute('aria-expanded','true')">高级设置</button>
<div id="settings" hidden><span>自主声明</span><button id="declaration" onclick="showOptions()">无需添加声明</button></div>
<button id="publish" disabled onclick="publishVideo()">发布</button></section><div id="success" role="status" hidden>发布成功</div><div id="failure" role="alert" hidden>发布失败，请验证</div>
<script>
window.posts=0;function uploaded(){window.names=Array.from(document.querySelector('input[type=file]').files).map(f=>f.name);history.replaceState({},'', '/creator-micro/content/post/video');setTimeout(()=>{document.querySelector('#editor').hidden=false;document.querySelector('#publish').disabled=false;},100);}
function showOptions(){const menu=document.createElement('div');menu.id='menu';menu.setAttribute('role','listbox');for(const text of ['无需添加声明','内容由AI生成']){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=text;option.onclick=()=>{document.querySelector('#declaration').textContent=text;menu.remove();};menu.append(option);}document.body.append(menu);}
function publishVideo(){window.posts++;window.sentDeclaration=document.querySelector('#declaration').textContent;document.querySelector('${outcome==='success'?'#success':'#failure'}').hidden=false;}
</script>`;
async function setup(t,handler){
  const dir=mkdtempSync(join(tmpdir(),'matrix-creators-test-'));
  const runtime=new BrowserRuntime(dir,{headless:true,launcher:{launchPersistentContext:async(directory,options)=>{
    const context=await chromium.launchPersistentContext(directory,{...options,headless:true});await context.route('**/*',handler);return context;
  }}});
  const studio=createStudio({dataDir:dir,browserRuntime:runtime,tickMs:10});
  await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await studio.close();const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('matrix-creators-test-'))throw Error('测试目录无效');rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:150});});
  const origin=`http://127.0.0.1:${studio.server.address().port}`;
  const state=()=>fetch(origin+'/api/state').then(r=>r.json()),token=(await state()).token;
  const post=async(path,body)=>{const r=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const upload=async(name,mime)=>{
    const r=await fetch(origin+'/api/assets',{method:'POST',headers:{'X-Studio-Token':token,'X-File-Name':encodeURIComponent(name),'Content-Type':mime},body:Buffer.from('fixture media')});return (await r.json()).id;
  };
  return {runtime,studio,post,state,upload};
}
const html=`<!doctype html><meta charset="utf-8"><div class="user-info">小红书号：xhs_fixture</div>
<button role="tab" onclick="selectMode('video')">上传视频</button><button role="tab" onclick="selectMode('note')">上传图文</button>
<input id="file" type="file" accept="video/*" multiple onchange="uploaded()">
<section id="editor" hidden><input placeholder="填写标题会有更多赞哦"><div class="tiptap ProseMirror" contenteditable="true" role="textbox"></div>
<div><span>作品声明</span><button id="declaration" onclick="openDeclaration()">无声明</button></div><button id="publish" disabled onclick="publishNote()">发布</button></section>
<div role="status" id="success" hidden>发布成功</div>
<script>
window.mode='video';window.posts=0;
function selectMode(mode){window.mode=mode;document.querySelector('#file').accept=mode==='video'?'video/*':'image/*';}
function uploaded(){window.fileNames=Array.from(document.querySelector('#file').files).map(f=>f.name);document.querySelector('#editor').hidden=false;setTimeout(()=>document.querySelector('#publish').disabled=false,150);}
function openDeclaration(){if(document.querySelector('#options'))return;const menu=document.createElement('div');menu.id='options';for(const text of ['无声明','内容由AI生成']){const item=document.createElement('div');item.textContent=text;item.onclick=()=>{document.querySelector('#declaration').textContent=text;menu.remove();};menu.append(item);}document.body.append(menu);}
function publishNote(){window.posts++;window.sentAi=document.querySelector('#declaration').textContent;document.querySelector('#success').hidden=false;}
</script>`;

for(const type of ['note','video'])test('小红书完整发布：'+type+'，账号识别、上传顺序、作品声明、静默自动提交',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  const id=(await app.post('accounts',{platform:'xhs',name:'小红书回归账号'})).body.id;
  await app.post(`accounts/${id}/open`,{});assert.equal((await app.post(`accounts/${id}/check`,{})).status,200);
  const assets=type==='note'?[await app.upload('第一张.png','image/png'),await app.upload('第二张.jpg','image/jpeg')]:[await app.upload('视频.mp4','video/mp4')];
  const content={type,title:'小红书联调',body:'第一段\n第二段',assetIds:assets,versions:{xhs:{title:'平台专属标题'}},publication:{mode:'auto',aiAssisted:true,silent:true}};
  assert.equal((await app.post('dispatch',{content,accountIds:[id],requestKey:'xhs-'+type})).status,201);
  const deadline=Date.now()+30000;let job;
  do{job=(await app.state()).jobs[0];if(['submitted','needs_manual','needs_login','unknown'].includes(job.state))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  assert.equal(job.state,'submitted',JSON.stringify(job.events));assert.equal(job.receipt.simulated,false);assert.equal(job.receipt.id,null);assert.equal(job.receipt.aiDisclosure.checked,true);
  const session=app.runtime.sessions.get(id);assert.equal(session.headless,true);assert.equal(await session.page.evaluate(()=>window.posts),1);
  assert.deepEqual(await session.page.evaluate(()=>window.fileNames),type==='note'?['第一张.png','第二张.jpg']:['视频.mp4']);
  assert.equal(await session.page.locator('input[placeholder]').inputValue(),'平台专属标题');assert.equal(await session.page.evaluate(()=>window.sentAi),'内容由AI生成');
});

test('抖音账号独立接入、错号阻断；文章类型不开放',async t=>{
  let handle='douyin_fixture';
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<div class="user-info">抖音号：${handle}</div>`}));
  const a=(await app.post('accounts',{platform:'douyin',name:'抖音本人账号'})).body.id;await app.post(`accounts/${a}/open`,{});
  assert.equal((await app.post(`accounts/${a}/check`,{})).status,200);
  assert.equal((await app.state()).accounts.find(x=>x.id===a).platform_id,'douyin_fixture');
  handle='different_user';assert.equal((await app.post(`accounts/${a}/check`,{})).status,409);
  const invalid=await app.post('validate',{content:{type:'article',title:'不应投稿',body:'正文',assetIds:[]},accountIds:[a]});assert.match(invalid.body.issues.join(),/不支持该内容类型/);
});

test('小红书仅监听页面自身的用户信息响应，不将Cookie当作登录',async t=>{
  const app=await setup(t,route=>route.request().url().endsWith('/api/galaxy/user/selfinfo')?route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data:{user_info:{user_id:'self-user-id',redId:'self-red-id',nickname:'测试昵称'}}})}):route.fulfill({contentType:'text/html; charset=utf-8',body:'<script>fetch("/api/galaxy/user/selfinfo")</script>'}));
  const a={id:'xhs-response',platform:'xhs',name:'响应身份'};await app.runtime.open(a,true);
  assert.equal((await app.runtime.check(a,true)).platformId,'self-red-id');
  assert.equal((await app.runtime.check({...a,platform_id:'self-user-id'},true)).platformId,'self-user-id');
  await assert.rejects(app.runtime.check({...a,platform_id:'other'},true),/身份与绑定账号不同/);
});

test('小红书素材与能力校验：拒绝图文混视频和长文章',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html',body:html}));
  const a=(await app.post('accounts',{platform:'xhs',name:'素材校验'})).body.id;
  const img=await app.upload('图.png','image/png'),video=await app.upload('片.mp4','video/mp4');
  const base={title:'标题',body:'正文',assetIds:[img,video]};
  assert.match((await app.post('validate',{content:{...base,type:'note'},accountIds:[a]})).body.issues.join(),/不能混入视频/);
  assert.match((await app.post('validate',{content:{...base,type:'article'},accountIds:[a]})).body.issues.join(),/不支持该内容类型/);
});

test('新平台登录页不会凭Cookie或昵称被标为已连接',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="user-info">测试昵称</div><div>扫码登录</div>'}));
  for(const platform of ['xhs','douyin']){
    const a={id:platform+'-anonymous',platform,name:'匿名回归'};const session=await app.runtime.open(a,true);
    await session.context.addCookies([{name:'fake-session',value:'exists',url:platform==='xhs'?'https://creator.xiaohongshu.com/':'https://creator.douyin.com/'}]);
    await assert.rejects(app.runtime.check(a,true),/完成扫码登录/);
  }
});


async function waitJob(app,states){const end=Date.now()+20000;let job;do{job=(await app.state()).jobs[0];if(states.includes(job?.state))return job;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw Error(JSON.stringify(job?.events));}
async function douyinTask(app,key,publication){
  const a=(await app.post('accounts',{platform:'douyin',name:'抖音视频联调'})).body.id;await app.post('accounts/'+a+'/open',{});assert.equal((await app.post('accounts/'+a+'/check',{})).status,200);
  const asset=await app.upload('抖音视频.mp4','video/mp4');
  const c={type:'video',title:'统一标题',body:'视频简介\n第二段',assetIds:[asset],versions:{douyin:{title:'抖音专属标题'}},publication};
  assert.equal((await app.post('dispatch',{requestKey:key,content:c,accountIds:[a]})).status,201);return a;
}
for(const aiAssisted of [true,false])test('抖音静默视频发布、异步编辑器与高级设置声明：AI='+aiAssisted,async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:douyinHtml()}));
  const a=await douyinTask(app,'douyin-auto-'+aiAssisted,{mode:'auto',aiAssisted,silent:true});
  const job=await waitJob(app,['submitted','needs_manual','needs_login','unknown']);assert.equal(job.state,'submitted',JSON.stringify(job.events));
  const session=app.runtime.sessions.get(a);assert.equal(session.headless,false);assert.equal(session.background,true);assert.equal(await session.page.evaluate(()=>window.posts),1);
  assert.deepEqual(await session.page.evaluate(()=>window.names),['抖音视频.mp4']);assert.equal(await session.page.locator('input[placeholder]').inputValue(),'抖音专属标题');
  assert.equal(await session.page.evaluate(()=>window.sentDeclaration),aiAssisted?'内容由AI生成':'无需添加声明');
  assert.equal(job.receipt.aiDisclosure.checked,aiAssisted?true:null);assert.equal(job.receipt.id,null);assert.equal(job.receipt.simulated,false);
  assert.equal(await session.page.locator('#advanced').getAttribute('aria-expanded'),aiAssisted?'true':'false');
});
test('抖音人工发布先暂停，确认前发现文案被改动则阻断，恢复后仅提交一次',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:douyinHtml()}));
  const a=await douyinTask(app,'douyin-manual',{mode:'manual',aiAssisted:false});const job=await waitJob(app,['awaiting_confirmation','needs_manual']);assert.equal(job.state,'awaiting_confirmation',JSON.stringify(job.events));
  const page=app.runtime.sessions.get(a).page;assert.equal(await page.evaluate(()=>window.posts),0);
  await page.locator('input[placeholder]').fill('临时更改标题');await app.post('jobs/'+job.id+'/confirm',{confirmReal:true});
  assert.equal((await app.state()).jobs[0].state,'needs_manual');assert.equal(await page.evaluate(()=>window.posts),0);
  assert.equal((await app.post('jobs/'+job.id+'/retry',{})).status,200);await waitJob(app,['awaiting_confirmation']);
  assert.equal((await app.post('jobs/'+job.id+'/confirm',{confirmReal:true})).status,200);assert.equal((await app.state()).jobs[0].state,'submitted');
  assert.equal(await app.runtime.sessions.get(a).page.evaluate(()=>window.posts),1);
});
test('抖音提交后报错进入结果未知，禁止自动或手动重发',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:douyinHtml('error')}));
  const a=await douyinTask(app,'douyin-unknown',{mode:'auto',aiAssisted:false,silent:true});const job=await waitJob(app,['unknown','needs_manual','submitted']);
  assert.equal(job.state,'unknown',JSON.stringify(job.events));assert.equal(await app.runtime.sessions.get(a).page.evaluate(()=>window.posts),1);
  assert.equal((await app.post('jobs/'+job.id+'/retry',{})).status,409);assert.equal((await app.post('jobs/'+job.id+'/confirm',{confirmReal:true})).status,409);
});
test('抖音视频素材校验拒绝多视频和混入图片',async t=>{
  const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:douyinHtml()}));
  const a=(await app.post('accounts',{platform:'douyin',name:'抖音素材校验'})).body.id;
  const img=await app.upload('图.png','image/png'),video=await app.upload('片.mp4','video/mp4');
  for(const assetIds of [[video,img],[video,video]])assert.match((await app.post('validate',{content:{type:'video',title:'标题',body:'简介',assetIds},accountIds:[a]})).body.issues.join(),/仅选择一个视频/);
});


test('小红书身份信息晚于DOMContentLoaded出现时等待，不将已登录误判失效',async t=>{
 const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="user-info"></div><script>setTimeout(()=>document.querySelector(".user-info").textContent="小红书号：delayed_self",2200)</script>'}));
 const a={id:'xhs-delayed',platform:'xhs',platform_id:'delayed_self'};await app.runtime.open(a,true);
 assert.equal((await app.runtime.check(a,true)).platformId,'delayed_self');
});

test('小红书重定向导致执行环境短暂销毁时恢复检查，错号仍被阻断',async t=>{
 const app=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="user-info">小红书号：redirect_self</div>'}));
 const a={id:'xhs-transient',platform:'xhs',platform_id:'redirect_self'};const s=await app.runtime.open(a,true);
 await app.runtime.check(a,true);const probe=s.identityProbe.page,original=probe.evaluate.bind(probe);let remaining=2;
 probe.evaluate=(...args)=>{if(remaining-->0)return Promise.reject(Error('Execution context was destroyed, most likely because of a navigation'));return original(...args);};
 assert.equal((await app.runtime.check(a,true)).platformId,'redirect_self');
 await assert.rejects(app.runtime.check({...a,platform_id:'other'},true),e=>e.state==='identity_mismatch');
});

test('新鲜自身身份响应可先于DOM检查使用；不等待无响应的页面查询',async t=>{
 const {creatorIdentityReady}=await import('../creator-identity.mjs');let evaluated=false;
 const page={url:()=> 'https://creator.xiaohongshu.com/new/home',evaluate:()=>{evaluated=true;return new Promise(()=>{});}};
 const identity={platformId:'fresh_self',aliases:['fresh_self']};
 assert.equal((await creatorIdentityReady(page,'xhs',()=>identity,Date.now(),{timeoutMs:200})).platformId,'fresh_self');assert.equal(evaluated,false);
 const start=Date.now();assert.equal(await creatorIdentityReady(page,'xhs',()=>null,Date.now(),{timeoutMs:100}),null);assert.ok(Date.now()-start<1500);
});
