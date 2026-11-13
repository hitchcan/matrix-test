import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {observeVisualRecovery} from '../workflow/visual-recovery.mjs';
import {BrowserRuntime,PublishAdapter} from '../browser-runtime.mjs';

async function setup(t,html) {
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:900,height:700}});
  await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  const page=await context.newPage();await page.goto('https://zhuanlan.zhihu.com/write');return {page,context};
}
const hosts=['zhuanlan.zhihu.com'];
const fixture='<p>private-account-secret</p><textarea>private-draft-secret</textarea><div class="unknown-popover"><button type="button" onclick="window.dismissed=1;this.parentElement.remove()">我知道了</button></div><button type="button" onclick="window.published=1">发布</button><form><button>重试</button></form><a href="https://outside.example/"><button type="button">关闭</button></a>';

test('视觉恢复只开放当前页安全控件，图片上下文脱敏，一次性原生点击不会发布',async t=>{
  const {page,context}=await setup(t,fixture),other=await context.newPage();await other.goto('https://zhuanlan.zhihu.com/another');
  const snapshot=await observeVisualRecovery(page,hosts);
  assert.equal(snapshot.observation.mode,'visual');assert.match(snapshot.observation.screenshot,/^data:image\/png;base64,/);
  assert.deepEqual(snapshot.observation.targets.map(t=>t.label),['我知道了']);
  assert.ok(!JSON.stringify({...snapshot.observation,screenshot:null}).includes('secret'));
  const action={action:'click',token:snapshot.observation.token,targetId:snapshot.observation.targets[0].id};
  assert.equal(await snapshot.perform({...action,targetId:'publish'}),false);
  // Invalid requests consume the capability; obtain a fresh observation.
  await snapshot.dispose();const fresh=await observeVisualRecovery(page,hosts);
  const click={action:'click',token:fresh.observation.token,targetId:fresh.observation.targets[0].id};
  assert.equal(await fresh.perform(click),true);assert.equal(await fresh.perform(click),false);
  assert.equal(await page.evaluate(()=>window.dismissed),1);assert.equal(await page.evaluate(()=>!!window.published),false);
  assert.equal(await other.evaluate(()=>!!window.dismissed),false);await fresh.dispose();
});

test('视觉动作拒绝页面变化、遮挡、未知参数、跨域及本人验证',async t=>{
  const {page}=await setup(t,fixture);
  let snapshot=await observeVisualRecovery(page,hosts),targetId=snapshot.observation.targets[0].id;
  await page.locator('p').evaluate(n=>n.textContent='changed');
  assert.equal(await snapshot.perform({action:'click',targetId,token:snapshot.observation.token}),false);await snapshot.dispose();
  snapshot=await observeVisualRecovery(page,hosts);
  assert.equal(await snapshot.perform({action:'click',targetId,token:snapshot.observation.token,x:1}),false);await snapshot.dispose();
  await page.evaluate(()=>{const n=document.createElement('div');n.style='position:fixed;inset:0;background:white;z-index:99';document.body.append(n);});
  snapshot=await observeVisualRecovery(page,hosts);
  assert.equal(await snapshot.perform({action:'click',targetId,token:snapshot.observation.token}),false);await snapshot.dispose();
  assert.deepEqual(await observeVisualRecovery(page,['other.example']),{human:true});
  await page.setContent('<input autocomplete="one-time-code">');let captured=0;
  const screenshot=page.screenshot.bind(page);page.screenshot=(...args)=>{captured++;return screenshot(...args);};
  assert.deepEqual(await observeVisualRecovery(page,hosts),{human:true});assert.equal(captured,0);
});

test('视觉恢复只滚动当前文档，输入仅恢复可信快照标题，导航与弹窗被阻断',async t=>{
  const {page,context}=await setup(t,'<textarea id="title"></textarea><button type="button" onclick="window.open(\'https://outside.example/\')">关闭</button><div style="height:2000px"></div>');
  let snapshot=await observeVisualRecovery(page,hosts,{selector:'#title',title:'trusted-title',url:page.url()});
  assert.equal(await snapshot.perform({action:'restore_title',token:snapshot.observation.token}),true);await snapshot.dispose();
  assert.equal(await page.locator('#title').inputValue(),'trusted-title');
  snapshot=await observeVisualRecovery(page,hosts);assert.equal(await snapshot.perform({action:'scroll',direction:'down',token:snapshot.observation.token}),true);await snapshot.dispose();
  assert.ok(await page.evaluate(()=>scrollY>0));await page.evaluate(()=>scrollTo(0,0));
  snapshot=await observeVisualRecovery(page,hosts);const id=snapshot.observation.targets[0].id;
  await snapshot.perform({action:'click',targetId:id,token:snapshot.observation.token});
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(context.pages().length,1);assert.equal(page.url(),'https://zhuanlan.zhihu.com/write');await snapshot.dispose();
  await page.locator('button').evaluate(n=>n.onclick=()=>location.assign('https://outside.example/'));
  snapshot=await observeVisualRecovery(page,hosts);await snapshot.perform({action:'click',targetId:snapshot.observation.targets[0].id,token:snapshot.observation.token});
  await new Promise(resolve=>setTimeout(resolve,150));assert.notEqual(new URL(page.url()).hostname,'outside.example');await snapshot.dispose();
  assert.deepEqual(await observeVisualRecovery(page,hosts),{human:true});
});

test('视觉阶段拦截当前页写请求，其他账号页不受控制，换页使旧能力失效',async t=>{
  const {page,context}=await setup(t,'<button type="button" onclick="fetch(\'/publish\',{method:\'POST\'}).catch(()=>{})">重试</button>');
  let posts=0;await context.route('**/publish',r=>{posts++;return r.fulfill({body:'ok'});});
  const runtime=Object.create(BrowserRuntime.prototype),account={id:'bound-account',platform:'zhihu'};
  runtime.sessions=new Map([[account.id,{page,context}]]);
  let snapshot=await runtime.observeVisualRecovery(account);
  assert.equal(await snapshot.perform({action:'click',token:snapshot.observation.token,targetId:snapshot.observation.targets[0].id}),true);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(posts,0);await snapshot.dispose();
  snapshot=await runtime.observeVisualRecovery(account);const other=await context.newPage();await other.goto('https://zhuanlan.zhihu.com/other');
  runtime.sessions.set(account.id,{page:other,context});
  assert.equal(await snapshot.perform({action:'click',token:snapshot.observation.token,targetId:snapshot.observation.targets[0].id}),false);
  await snapshot.dispose();assert.equal(posts,0);
});

test('视觉恢复后标准准备保留已修复账号页，继续重填复核而不刷新丢失现场',async t=>{
  const {page}=await setup(t,'<input id="title" type="text"><textarea id="body"></textarea>');let navigations=0;
  page.on('framenavigated',()=>navigations++);
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({page})};
  const adapter=new PublishAdapter(runtime,{zhihu:{article:{url:'https://zhuanlan.zhihu.com/write',title:'#title',body:'#body'}}},()=>null);
  const account={platform:'zhihu',status:'connected',platform_id:'owner'},content={type:'article',title:'可信标题',body:'可信正文',assetIds:[]};
  await adapter.prepare(account,content);assert.equal(navigations,1);
  await page.evaluate(()=>window.repaired=true);await adapter.prepare(account,content,{resumeRecovery:true});
  assert.equal(navigations,1);assert.equal(await page.evaluate(()=>window.repaired),true);assert.equal(await page.locator('#body').inputValue(),'可信正文');
});
