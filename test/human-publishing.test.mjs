import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {BrowserRuntime,PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
import {bilibiliCoverReady,requireBilibiliCover,uploadBilibiliCover} from '../bilibili-cover.mjs';
import {douyinReceipt} from '../douyin-publisher.mjs';
import {douyinVerificationPage} from '../douyin-verification.mjs';
import {fileURLToPath} from 'node:url';
import {createStudio} from '../server.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=';
function temp(t,beforeCleanup=async()=>{}){const d=mkdtempSync(join(tmpdir(),'matrix-human-'));t.after(async()=>{await beforeCleanup();const p=resolve(d);if(dirname(p)!==resolve(tmpdir())||!basename(p).startsWith('matrix-human-'))throw Error('测试目录无效');rmSync(p,{recursive:true,force:true});});return d;}
async function pageFor(t){const b=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});t.after(()=>b.close());const p=await b.newPage();p.setDefaultTimeout(15000);return p;}
test('工作台封面上传独立保存，不混入视频素材；草稿保留所选封面',{timeout:60000},async t=>{
 let studio,p;const d=temp(t,async()=>{await p?.context().browser()?.close();await studio?.close();});studio=createStudio({dataDir:d});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+studio.server.address().port; p=await pageFor(t);const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(origin);await p.locator('#cover-upload').waitFor();await p.locator('#cover-upload').setInputFiles({name:'我的封面.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await p.getByRole('option',{name:'我的封面.png',exact:true}).waitFor({state:'attached'});
 const chosen=await p.locator('[data-field="coverAssetId"]').inputValue();assert.ok(chosen);await p.locator('#save-draft').click();
 const end=Date.now()+5000;let state;do{state=await(await fetch(origin+'/api/state')).json();if(state.drafts.length)break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<end);
 assert.equal(state.drafts[0].coverAssetId,chosen);assert.deepEqual(state.drafts[0].assetIds,[]);assert.equal(state.assets.length,1);assert.deepEqual(errors,[]);
});
test('B站缺少封面时在最终投稿前暂停，不点击立即投稿',async t=>{
 const p=await pageFor(t),html=readFileSync(new URL('fixtures/bilibili-saved-video.html',import.meta.url),'utf8').replace(/<div class="cover-module-main">[\s\S]*$/,'<div class="cover-module-main"><div class="cover-slot"><div class="cover-empty"><span>添加封面</span></div></div></div>');
 await p.context().route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));await p.goto('https://member.bilibili.com/platform/upload/video/frame');
 const rules=loadAdapterRules(fileURLToPath(new URL('..',import.meta.url))),a={platform:'bilibili',platform_id:'self',status:'connected'},c={type:'video',title:'标题',body:'简介',publication:{mode:'auto',aiAssisted:false}};
 await p.locator('input[placeholder*="创作声明"]').evaluate(n=>n.value='内容无需标注');await p.locator(rules.bilibili.video.title).fill(c.title);await p.locator(rules.bilibili.video.body).fill(c.body);
 const adapter=new PublishAdapter({check:async()=>({platformId:'self'}),open:async()=>({page:p})},rules,()=>null);let clicks=0;
 await assert.rejects(adapter.submit(a,c,()=>clicks++),e=>e.state==='awaiting_confirmation'&&/封面/.test(e.message));assert.equal(clicks,0);
});
test('B站指定封面：区分三个图片入口，确认双比例同步后才读回保存',async t=>{
 const dir=temp(t),file=join(dir,'cover.png');writeFileSync(file,Buffer.from(png,'base64'));const p=await pageFor(t);
 await p.setContent('<div class="cover-module-main"><div class="cover-slot"><div class="cover-empty">添加封面</div></div></div><div class="cover-editor bcc-dialog__wrap" hidden><div class="cover-editor-panel-canvas-empty">4:3</div><div class="cover-editor-panel-canvas-empty">16:9</div><input type="file" accept="image/png"><input type="file" accept="image/png"><div class="cover-editor-panel-select"><div class="cover-upload"><div class="upload-area">上传封面</div><input id="cover" type="file" accept="image/png,image/jpeg" hidden></div></div><div class="cover-editor-button"><div class="button submit"> 完成 </div></div></div>');
 await p.evaluate(png=>{
  document.querySelector('.cover-slot').onclick=()=>document.querySelector('.cover-editor').hidden=false;
  document.querySelector('.upload-area').onclick=()=>document.querySelector('#cover').click();
  document.querySelector('#cover').onchange=()=>{window.coverName=document.querySelector('#cover').files[0].name;document.querySelectorAll('.cover-editor-panel-canvas-empty').forEach(n=>n.remove());};
  const sync=document.createElement('div');sync.className='videoup-confirm-modal';sync.hidden=true;sync.innerHTML='是否将「4:3封面」的改动同步到「16:9封面」？<button>确认同步</button>';document.body.append(sync);window.synced=0;document.querySelector('.cover-editor-button .submit').onclick=()=>sync.hidden=false;sync.querySelector('button').onclick=()=>{window.synced++;sync.hidden=true;document.querySelector('.cover-slot').innerHTML='<img alt="封面" src="data:image/png;base64,'+png+'">';document.querySelector('.cover-editor').hidden=true;};
 },png);
 assert.equal(await bilibiliCoverReady(p),false);await assert.rejects(requireBilibiliCover(p),/尚未设置/);
 await uploadBilibiliCover(p,{path:file,name:'指定封面.png',mime:'image/png'});assert.equal(await bilibiliCoverReady(p),true);assert.equal(await p.evaluate(()=>window.coverName),'指定封面.png');assert.equal(await p.evaluate(()=>window.synced),1);assert.deepEqual(await p.locator('input[type=file]').evaluateAll(ns=>ns.slice(0,2).map(n=>n.files.length)),[0,0]);
});
test('抖音验证识别只读取交互验证层；正文提到验证不误报，验证后只读成功',async t=>{
 const p=await pageFor(t);await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<div contenteditable="true">正文提到安全验证</div><div id="captcha_container" hidden style="width:300px;height:150px">请完成安全验证</div><p id="success" hidden>发布成功</p><button id="publish">发布</button>'}));await p.goto('https://creator.douyin.com/creator-micro/content/post/video');
 assert.equal(await douyinVerificationPage(p),null);await p.locator('#captcha_container').evaluate(n=>n.hidden=false);
 await assert.rejects(douyinReceipt(p,{resultTimeoutMs:100}),e=>e.state==='needs_verification'&&e.verificationPage===p);
 const a={id:'one',platform:'douyin'},rules={douyin:{video:{flow:'douyin',url:'https://creator.douyin.com/creator-micro/content/post/video'}}},adapter=new PublishAdapter({sessions:new Map([['one',{page:p}]])},rules,()=>null);
 await assert.rejects(adapter.checkResult(a,{type:'video'}),/无法将当前页面归因/);adapter.pendingSubmissions.set(a.id,{page:p,content:JSON.stringify({type:'video'})});
 assert.equal((await adapter.checkResult(a,{type:'video'})).state,'needs_verification');
 await p.evaluate(()=>{document.querySelector('#captcha_container').hidden=true;document.querySelector('#success').hidden=false;});
 const result=await adapter.checkResult(a,{type:'video'});assert.equal(result.state,'submitted');assert.equal(result.receipt.id,null);
});
test('抖音后台模式保留同一页面，显示验证窗口不重启浏览器、不丢验证状态',async t=>{
 let runtime;const d=temp(t,()=>runtime?.close()),launches=[];runtime=new BrowserRuntime(d,{launcher:{launchPersistentContext:async(dir,options)=>{launches.push(options.headless);const c=await chromium.launchPersistentContext(dir,{...options,headless:true});await c.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<div>fixture</div>'}));return c;}}});
 const a={id:'douyin-window',platform:'douyin'};await runtime.setMode(a,true);const original=runtime.sessions.get(a.id),p=original.page;await p.evaluate(()=>window.verificationState='preserved');await runtime.reveal(a);await runtime.setMode(a,false);
 assert.equal(runtime.sessions.get(a.id),original);assert.equal(original.page,p);assert.equal(await p.evaluate(()=>window.verificationState),'preserved');assert.equal(original.background,false);assert.deepEqual(launches,[false]);
});

test('B站真实cover-img背景图封面可读回，不要求img标签',async t=>{const p=await pageFor(t);await p.setContent('<div class="cover-module-main"><div class="cover-slot"><div class="cover-img" style="background-image:url(https://example.test/cover.jpg);width:120px;height:90px">封面设置</div></div></div>');assert.equal(await bilibiliCoverReady(p),true);await requireBilibiliCover(p);});

for(const embedded of [false,true])test('抖音无dialog角色短信验证码识别，iframe='+embedded,async t=>{
 const p=await pageFor(t),html='<main><div><h3>接收短信验证码</h3><p>为确保是本人操作抖音账号</p><section><input placeholder="请输入验证码" style="width:220px;height:40px"><button id="send" onclick="window.sent=(window.sent||0)+1">获取验证码</button></section><button>验证</button></div></main>';
 await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:embedded&&r.request().url().includes('creator.douyin.com')?'<iframe src="https://verify.snssdk.com/sms" style="width:500px;height:500px"></iframe>':html}));await p.goto('https://creator.douyin.com/creator-micro/content/post/video');if(embedded)await p.frameLocator('iframe').locator('input').waitFor();
 assert.equal(await douyinVerificationPage(p),p);await assert.rejects(douyinReceipt(p,{resultTimeoutMs:100}),e=>e.state==='needs_verification');const frame=embedded?p.frames().find(f=>f.url().includes('snssdk.com')):p.mainFrame();assert.equal(await frame.locator('input').inputValue(),'');assert.equal(await frame.evaluate(()=>window.sent||0),0);
 if(embedded){await p.locator('iframe').evaluate(n=>n.hidden=true);assert.equal(await douyinVerificationPage(p),null);}
});
