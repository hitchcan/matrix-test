import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime, PublishAdapter } from '../browser-runtime.mjs';

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body><header class="bcc-global-header"><a href="https://space.bilibili.com/123456">测试账号</a></header><input id="file" type="file"><input id="title"><textarea id="body"></textarea><button id="submit" onclick="document.querySelector('#success').hidden=false">提交</button><p id="success" hidden>已提交</p></body></html>`;
async function setup(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-browser-test-'));
  const launches=[];
  const launcher = { launchPersistentContext: async (directory, options) => {
    launches.push(options.headless);
    const context = await chromium.launchPersistentContext(directory, { ...options, headless: true });
    await context.route('**/*', handler || (route => route.fulfill({contentType:'text/html', body:fixture})));
    return context;
  } };
  const runtime = new BrowserRuntime(dir, {launcher, headless:true});
  t.after(async () => { await runtime.close(); const path=resolve(dir); if (dirname(path)!==resolve(tmpdir()) || !basename(path).startsWith('matrix-browser-test-')) throw Error('清理路径无效'); rmSync(path,{recursive:true,force:true}); });
  return {dir,runtime,launches};
}
const account = {id:'account-one',platform:'bilibili',name:'测试账号',platform_id:'123456',status:'connected'};
test('真实Chromium：账号环境隔离、关闭重开复用、DOM身份核验和错号阻断', async t => {
  const {runtime} = await setup(t);
  const first = await runtime.open(account,true);
  await first.context.addCookies([{name:'fixture-session',value:'one',url:'https://member.bilibili.com/'}]);
  const second = await runtime.open({...account,id:'account-two'},true);
  assert.equal((await second.context.cookies()).length,0);
  assert.equal((await runtime.check(account)).platformId,'123456');
  await assert.rejects(runtime.check({...account,platform_id:'different'}),/身份与绑定账号不同/);
  await runtime.disconnect(account.id);
  const restored = await runtime.open(account,true);
  assert.equal((await restored.context.cookies()).find(c=>c.name==='fixture-session').value,'one');
});

test('知乎扫码后自动读取当前账号，不依赖头像链接、不刷新页面；错号继续阻断',async t=>{
  let loggedIn=false;
  const {runtime}=await setup(t,route=>route.request().url().endsWith('/api/v4/me')?route.fulfill({status:loggedIn?200:401,contentType:'application/json',body:JSON.stringify(loggedIn?{id:'fixture-id',url_token:'fixture-zhihu',name:'测试账号'}:{error:{code:100}})}):route.fulfill({contentType:'text/html',body:'<html><body><input id="unsaved" value="编辑中"></body></html>'}));
  const a={id:'zhihu-login',platform:'zhihu',name:'知乎测试'};
  const {page}=await runtime.open(a,true);
  await assert.rejects(runtime.check(a),/等待登录完成/);
  loggedIn=true;
  await page.locator('#unsaved').fill('不要刷新');
  const result=await runtime.check(a);
  assert.equal(result.platformId,'fixture-zhihu');
  assert.equal(await page.locator('#unsaved').inputValue(),'不要刷新');
  await assert.rejects(runtime.check({...a,platform_id:'another-user'}),/身份与绑定账号不同/);
});

test('富文本文章通过HTML粘贴到平台，保留加粗、标题和列表，提交前检查格式',async t=>{
  const html=fixture.replace('<textarea id="body"></textarea>','<div id="body" contenteditable="true"></div>');
  const {runtime}=await setup(t,route=>route.fulfill({contentType:'text/html',body:html}));
  const rule={url:'https://member.bilibili.com/platform/upload/text/edit',title:'#title',body:'#body',submit:'#submit',success:'#success'};
  const adapter=new PublishAdapter(runtime,{bilibili:{article:rule}},()=>null);
  const content={type:'article',title:'格式文章',body:'标题加粗列表',bodyHtml:'<h2>标题</h2><p><strong>加粗</strong></p><ul><li>列表</li></ul>',assetIds:[]};
  const {page}=await adapter.prepare(account,content);
  assert.equal(await page.locator('#body strong').innerText(),'加粗');
  assert.equal(await page.locator('#body h2').innerText(),'标题');
  assert.equal(await page.locator('#body li').innerText(),'列表');
  await page.locator('#body').evaluate(n=>n.innerHTML='<p>标题加粗列表</p>');
  await assert.rejects(adapter.submit(account,content,()=>{}),/正文检查未通过/);
});
test('真实Chromium：文件上传、文案填写、提交前变更阻断、独立成功证据', async t => {
  const {runtime,dir} = await setup(t);
  const path=join(dir,'sample.mp4'); writeFileSync(path,'fixture video');
  const rule={url:'https://member.bilibili.com/platform/upload/video/frame',upload:'#file',title:'#title',body:'#body',submit:'#submit',success:'#success'};
  const adapter = new PublishAdapter(runtime,{bilibili:{video:rule}},()=>({path,name:'sample.mp4',mime:'video/mp4'}));
  const content={type:'video',title:'统一标题',body:'统一简介',versions:{bilibili:{title:'平台标题'}},assetIds:['asset']};
  const {page} = await adapter.prepare(account,content);
  assert.equal(await page.locator('#title').inputValue(),'平台标题');
  assert.equal(await page.locator('#file').evaluate(n=>n.files[0].name),'sample.mp4');
  let clicked=false;
  await page.locator('#title').fill('已改变');
  await assert.rejects(adapter.submit(account,content,()=>{clicked=true;}),/文案已变化/);
  assert.equal(clicked,false);
  await page.locator('#title').fill('平台标题');
  const receipt = await adapter.submit(account,content,()=>{clicked=true;});
  assert.equal(clicked,true); assert.equal(receipt.simulated,false); assert.equal(receipt.id,null);
  await assert.rejects(adapter.submit(account,content,()=>{}),/已存在成功标志/);
  assert.throws(()=>adapter.rule({...account,platform:'douyin'},content),/尚未配置/);
});

test('AI辅助声明：按所选状态勾选或取消，提交前纠正变化，缺失或禁用时不点击发布',async t=>{
  const html=fixture.replace('<input id="file"', '<label><input id="ai" type="checkbox">包含 AI 辅助创作</label><input id="file"');
  const {runtime,dir}=await setup(t,route=>route.fulfill({contentType:'text/html',body:html}));
  const path=join(dir,'ai-video.mp4');writeFileSync(path,'fixture-video');
  const rule={url:'https://member.bilibili.com/platform/upload/video/frame',upload:'#file',title:'#title',body:'#body',submit:'#submit',success:'#success'};
  const adapter=new PublishAdapter(runtime,{bilibili:{video:rule}},()=>({path,name:'ai-video.mp4',mime:'video/mp4'}));
  const c={type:'video',title:'AI声明',body:'正文',assetIds:['video'],publication:{mode:'auto',aiAssisted:true}};
  let {page}=await adapter.prepare(account,c);
  assert.equal(await page.locator('#ai').isChecked(),true);
  await page.locator('#ai').uncheck();
  let clicked=false;
  const receipt=await adapter.submit(account,c,()=>{clicked=true;});
  assert.equal(clicked,true);assert.equal(await page.locator('#ai').isChecked(),true);assert.equal(receipt.aiDisclosure.checked,true);
  const no={...c,publication:{mode:'manual',aiAssisted:false}};
  ({page}=await adapter.prepare(account,no));
  await page.locator('#ai').check();
  await adapter.applyAiDisclosure(page,rule,no);assert.equal(await page.locator('#ai').isChecked(),false);
  await page.locator('#ai').evaluate(n=>n.remove());clicked=false;
  await assert.rejects(adapter.submit(account,no,()=>{clicked=true;}),/无法唯一定位/);assert.equal(clicked,false);
  await page.locator('body').evaluate(n=>n.insertAdjacentHTML('beforeend','<label><input id="ai" type="checkbox" checked disabled>包含 AI 辅助创作</label>'));
  await assert.rejects(adapter.submit(account,no,()=>{clicked=true;}),/无法设置/);assert.equal(clicked,false);
});

test('可见与静默执行参数切换串行关闭旧环境，复用会话Cookie与站点存储',async t=>{
  const {runtime,launches}=await setup(t);
  await runtime.setMode(account,false);
  const first=runtime.sessions.get(account.id);
  await first.context.addCookies([{name:'fixture-switch-session',value:'kept',url:'https://member.bilibili.com/'}]);
  await first.page.evaluate(()=>localStorage.setItem('switch-data','kept'));
  await runtime.setMode(account,true);
  const silent=runtime.sessions.get(account.id);
  assert.notEqual(first.context,silent.context);assert.equal(silent.headless,true);
  assert.equal((await silent.context.cookies()).find(c=>c.name==='fixture-switch-session').value,'kept');
  assert.equal(await silent.page.evaluate(()=>localStorage.getItem('switch-data')),'kept');
  await runtime.setMode(account,false);
  assert.deepEqual(launches,[false,true,false]);assert.equal(runtime.sessions.get(account.id).headless,false);
});


test('身份检查复用独立页面：即使page.close永不返回也不阻塞上传准备，不累积标签页',async t=>{
  let changed=false,closeCalls=0;
  const {runtime}=await setup(t,route=>route.fulfill({contentType:'text/html',body:changed?fixture.replace('123456','987654'):fixture}));
  const session=await runtime.open(account,true);
  await session.page.locator('#title').fill('保留编辑页');
  session.context.on('page',page=>{page.close=async()=>{closeCalls++;await new Promise(()=>{});};});
  let timer;
  const checked=await Promise.race([runtime.check(account,true),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('账号检查被页面关闭阻塞')),5000))]).finally(()=>clearTimeout(timer));
  assert.equal(checked.platformId,'123456');
  for(let i=0;i<3;i++)assert.equal((await runtime.check(account,true)).platformId,'123456');
  assert.equal(session.context.pages().length,2);assert.equal(closeCalls,0);
  assert.equal(await session.page.locator('#title').inputValue(),'保留编辑页');
  changed=true;await assert.rejects(runtime.check(account,true),/身份与绑定账号不同/);
  assert.equal(session.context.pages().length,2);assert.equal(closeCalls,0);
});


test('B站扫码后没有头像链接也能读取当前用户MID，保留编辑器且错号阻断',async t=>{
 let scanned=false;
 const {runtime}=await setup(t,route=>route.request().url().includes('api.bilibili.com/x/web-interface/nav')?route.fulfill({contentType:'application/json',body:JSON.stringify(scanned?{code:0,data:{isLogin:true,mid:567890,uname:'扫码本人'}}:{code:-101,data:{isLogin:false}})}):route.fulfill({contentType:'text/html; charset=utf-8',body:'<div>新版创作中心</div><a href="https://space.bilibili.com/999999">推荐作者</a><input id="draft" value="保留内容">'}));
 const a={id:'bili-scanned-new',platform:'bilibili',name:'B站新版'};const s=await runtime.open(a,true);
 await assert.rejects(runtime.check(a),e=>e.state==='detecting');scanned=true;
 assert.equal((await runtime.check(a)).platformId,'567890');assert.equal(await s.page.locator('#draft').inputValue(),'保留内容');
 assert.equal((await runtime.check({...a,platform_id:'567890'},true)).platformId,'567890');
 await assert.rejects(runtime.check({...a,platform_id:'111111'},true),e=>e.state==='identity_mismatch');
});
