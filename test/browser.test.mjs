import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime, PublishAdapter } from '../browser-runtime.mjs';
import {operationPacer} from '../browser-pace.mjs';

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

test('受控浏览器真实节奏等待后重新检查文案，间隔内发生修改时不占用提交名额',async t=>{
  const {runtime}=await setup(t);runtime.pacer=operationPacer({minMs:1,maxMs:2});
  let alter=true,gates=0;const phases=[],pace=runtime.pace.bind(runtime);
  runtime.pace=async(page,kind,options)=>{phases.push(kind);const duration=await pace(page,kind,options);if(kind==='submit'&&alter)await page.locator('#body').fill('等待期间被修改的正文');return duration;};
  const rule={url:'https://member.bilibili.com/platform/upload/text/edit',title:'#title',body:'#body',submit:'#submit',success:'#success'};
  const adapter=new PublishAdapter(runtime,{bilibili:{article:rule}},()=>null),content={type:'article',title:'节奏验证',body:'可信原文',assetIds:[]};
  await adapter.prepare(account,content);assert.ok(phases.includes('field'));assert.ok(phases.includes('navigate'));
  await assert.rejects(adapter.submit(account,content,async()=>gates++),/文案已变化/);assert.equal(gates,0);
  const {page}=await runtime.open(account);assert.equal(await page.locator('#success').isVisible(),false);
  alter=false;await page.locator('#body').fill(content.body);await adapter.submit(account,content,async()=>gates++);
  assert.equal(gates,1);assert.equal(phases.filter(kind=>kind==='submit').length,2);assert.equal(await page.locator('#success').isVisible(),true);
});
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
  await assert.rejects(adapter.submit(account,content,async()=>{throw new Error('gate rejected');}),/gate rejected/);
  assert.equal(await page.locator('#success').isVisible(),false);
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const submitting = adapter.submit(account,content,async()=>{
    waiting.resolve();
    await release.promise;
    clicked=true;
  });
  await waiting.promise;
  assert.equal(await page.locator('#success').isVisible(),false);
  release.resolve();
  const receipt = await submitting;
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

test('小红书独立只读页：排除基线同名稿、核对新稿，候选冲突保持歧义',async t=>{
  const {xhsReader} = await import('../workflow/xhs-reader.mjs');
  const rules = {url:'https://creator.xiaohongshu.com/fixture-manager',complete:'#end',row:'article',
    idAttribute:'data-id',title:'h2',body:'p',time:'time',type:'i',status:'span',types:{note:'图文'}};
  const row = id => `<article data-id="${id}"><h2>同题</h2><p>正文</p><time datetime="2021-01-01T12:00:00Z"></time><i>图文</i><span>审核中</span></article>`;
  let rows=row('old');
  const {runtime}=await setup(t,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:rows+'<footer id="end">已全部加载</footer>'}));
  const session=await runtime.open(account);
  const original=session.page.url();
  const reader=xhsReader({open:async()=>session,check:async()=>({platformId:'fixture'})},rules);
  const target={platform_id:'fixture'};
  const ctx={account:target,baseline:await reader.baseline(target),content:{title:'同题',body:'正文',type:'note'},attempts:[{invoked_at:'2021-01-01T11:59:00Z'}]};
  assert.equal((await reader.verify(ctx)).result,'inconclusive');
  rows+=row('new');
  assert.equal((await reader.verify(ctx)).externalId,'new');
  assert.equal((await reader.verify(ctx)).result,'found_reviewing');
  rows+=row('ambiguous');
  assert.equal((await reader.verify(ctx)).result,'ambiguous');
  assert.equal(session.page.url(),original);
  assert.equal(session.context.pages().length,2);
});

test('小红书跨状态分页完整覆盖，缺少页尾、空页与分页预算不计缺席',async t=>{
  const {xhsReader} = await import('../workflow/xhs-reader.mjs');
  const {requiredViews} = await import('../workflow/retry-evidence.mjs');
  const origin='https://creator.xiaohongshu.com';
  let broken='';
  const rules={url:origin+'/fixture',complete:'#ready',row:'article',idAttribute:'data-id',title:'h2',body:'p',type:'i',time:'time',status:'span',types:{note:'图文'},maxPages:2,views:{}};
  for(const v of requiredViews) rules.views[v]={url:origin+'/'+v,active:'#'+v,next:'a.next',end:'#end',empty:'#empty'};
  const {runtime}=await setup(t,route=>{
    const u=new URL(route.request().url()), view=u.pathname.slice(1);
    let body=`<main id="ready"><b id="${view}">当前列表</b></main>`;
    if(!(broken==='blank' && view==='draft')) body+='<b id="empty">零条</b>';
    if(view==='reviewing' && !u.search) body+='<a class="next" href="?page=2">下一页</a>';
    else if(!(broken==='end' && view==='draft')) body+='<b id="end">已到末页</b>';
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  const session=await runtime.open(account),target={platform_id:'fixture'};
  const reader=xhsReader({open:async()=>session,check:async()=>({platformId:'fixture'})},rules);
  const ctx={account:target,content:{title:'标题',body:'正文',type:'note'},attempts:[{invoked_at:'2021-01-01T00:00:00Z'}],baseline:await reader.baseline(target)};
  const result=await reader.verify(ctx);
  assert.equal(result.result,'absent_valid');assert.equal(result.coverage.pagesVisited,6);
  for(broken of ['end','blank']) await assert.rejects(reader.verify(ctx),/incomplete_page|blank_list/);
  broken='';rules.maxPages=1;await assert.rejects(reader.verify(ctx),/coverage_incomplete/);
});

test('Chromium 恢复观测仅暴露动作和一次性标识，拦截提交、DOM 变化和本人验证',async t=>{
  const {observeRecovery}=await import('../workflow/recovery-page.mjs');
  const {runtime}=await setup(t);
  const {page}=await runtime.open(account);
  await page.setContent('<dialog open>使用提示</dialog><button onclick="window.clicked=true">发布</button><textarea>私有草稿</textarea>');
  const hosts=['member.bilibili.com'];
  const first=await observeRecovery(page,hosts);
  assert.deepEqual(Object.keys(first.observation).sort(),['actions','token']);
  assert.equal(JSON.stringify(first.observation).includes('私有草稿'),false);
  assert.equal(await first.perform('click'),false);
  await page.locator('textarea').evaluate(el=>el.setAttribute('title','已变化'));
  assert.equal(await first.perform('dismiss_tip'),false);
  await first.dispose();
  const second=await observeRecovery(page,hosts);
  assert.notEqual(second.observation.token,first.observation.token);
  assert.equal(await second.perform('dismiss_tip'),true);
  assert.equal(await second.perform('dismiss_tip'),false);
  assert.equal(await page.locator('dialog').isVisible(),false);
  assert.equal(await page.evaluate(()=>!!window.clicked),false);
  await second.dispose();
  await page.setContent('<input id="title" type="text">');
  const editor={selector:'#title',title:'快照标题',url:page.url().split('?')[0]};
  const field=await observeRecovery(page,hosts,editor);
  assert.ok(field.observation.actions.includes('restore_title'));
  assert.equal(JSON.stringify(field.observation).includes('快照标题'),false);
  assert.equal(await field.perform('restore_title'),true);
  assert.equal(await page.locator('#title').inputValue(),'快照标题');
  await field.dispose();
  await page.setContent('<input autocomplete="one-time-code" value="fixture">');
  assert.deepEqual(await observeRecovery(page,hosts),{human:true});
});

test('管理页读取故障仅接管独立页，恢复提示后重新读取全部状态',async t=>{
  const {xhsReader}=await import('../workflow/xhs-reader.mjs');
  const {requiredViews}=await import('../workflow/retry-evidence.mjs');
  const base='https://creator.xiaohongshu.com';
  let broken=false,reads=0;
  const rules={url:base+'/manager',complete:'#ready',row:'article',idAttribute:'data-id',title:'h2',body:'p',type:'i',time:'time',status:'span',
    types:{note:'图文'},maxPages:1,views:{}};
  for(const view of requiredViews)rules.views[view]={url:base+'/'+view,active:'#'+view,next:'a.next',end:'#end',empty:'#empty'};
  const {runtime}=await setup(t,route=>{
    const view=new URL(route.request().url()).pathname.slice(1);
    reads++;
    const body=broken && view==='draft'
      ? '<main id="ready"><b id="draft">草稿</b></main><dialog open onclose="sessionStorage.fixed=1">使用提示</dialog><script>if(sessionStorage.fixed)document.querySelector("dialog").remove();if(sessionStorage.fixed)document.body.insertAdjacentHTML("beforeend",\'<p id="empty">空</p><b id="end">末页</b>\')</script>'
      : '<main id="ready"><b id="'+view+'">视图</b></main><p id="empty">空</p><b id="end">末页</b>';
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  const session=await runtime.open(account),editorUrl=session.page.url();
  let revealed;
  const reader=xhsReader({open:async()=>session,check:async()=>({platformId:'fixture'}),reveal:async(a,p)=>{revealed=p;}},rules);
  const target={platform_id:'fixture'},baseline=await reader.baseline(target);
  const ctx={account:target,baseline,content:{type:'note',title:'标题',body:'正文'},attempts:[{invoked_at:'2021-01-01T00:00:00Z'}]};
  broken=true;
  const failure=await reader.verify(ctx).then(()=>null,e=>e);
  assert.ok(failure.recoveryPage);
  await reader.reveal(target);assert.notEqual(revealed,session.page);
  const snapshot=await failure.recoveryPage.observe();
  assert.ok(snapshot.observation.actions.includes('dismiss_tip'));
  assert.equal(snapshot.observation.actions.includes('restore_title'),false);
  assert.equal(await snapshot.perform('dismiss_tip'),true);await snapshot.dispose();
  await revealed.waitForFunction(()=>sessionStorage.fixed==='1');
  const before=reads;
  assert.equal((await reader.verify(ctx)).result,'absent_valid');
  assert.ok(reads-before>=5);assert.equal(session.page.url(),editorUrl);
});

for(const fixture of [
  {platform:'zhihu',host:'www.zhihu.com',url:'https://zhuanlan.zhihu.com/p/12345',id:'12345',type:'article',label:'文章',review:'审核中'},
  {platform:'douyin',host:'creator.douyin.com',url:'https://www.douyin.com/video/123456789',id:'123456789',type:'video',label:'视频',review:'作品审核中'},
  {platform:'bilibili',host:'member.bilibili.com',url:'https://www.bilibili.com/video/BV1abcd23456/',id:'BV1abcd23456',type:'video',label:'视频投稿',review:'审核中稿件'}
])test('独立创作中心管理页：'+fixture.platform+' 账号、稿件链接、分页状态与回执优先',async t=>{
  const {creatorReader}=await import('../workflow/creator-reader.mjs');
  const {requiredViews}=await import('../workflow/retry-evidence.mjs');
  const base='https://'+fixture.host;
  const rules={url:base+'/manager',row:'article',link:'a',title:'h2',body:'p',status:'em',time:'time',type:'i',complete:'#ready',
    types:{[fixture.type]:fixture.label},statuses:{[fixture.review]:'found_reviewing'},maxPages:2,views:{}};
  for(const view of requiredViews)rules.views[view]={url:base+'/fixture/'+view,active:'#'+view,end:'#end',empty:'#empty',next:'a.next'};
  let found=false,foreign=false;
  const {runtime}=await setup(t,route=>{
    const u=new URL(route.request().url()),view=u.pathname.split('/').at(-1);
    const second=view==='reviewing' && u.search==='?page=2',more=view==='reviewing'&&!u.search;
    const entry=found&&second?`<article><a href="${foreign?'https://example.test/bad':fixture.url}">详情</a><h2>平台标题</h2><p>完整内容</p><em>${fixture.review}</em><i>${fixture.label}</i><time datetime="2021-01-01T12:00:00Z"></time></article>`:'<span id="empty">空</span>';
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<main id="ready"><b id="${view}">筛选</b>${entry}${more?'<a class="next" href="?page=2">下一页</a>':'<b id="end">末页</b>'}</main>`});
  });
  const session=await runtime.open(account);
  const reader=creatorReader({open:async()=>session,check:async()=>({platformId:'correct'})},fixture.platform,rules);
  const target={platform:fixture.platform,platform_id:'correct'},baseline=await reader.baseline(target);
  const ctx={account:target,content:{type:fixture.type,title:'默认标题',body:'完整内容',versions:{[fixture.platform]:{title:'平台标题'}}},baseline,attempts:[{invoked_at:'2021-01-01T00:00:00Z'}]};
  assert.equal((await reader.verify(ctx)).coverage.pagesVisited,6);
  assert.equal((await reader.verify({...ctx,baseline:{...baseline,signature:'expired'}})).result,'inconclusive');
  found=true;
  assert.equal((await reader.verify(ctx)).externalId,fixture.id);
  assert.equal((await reader.verify({...ctx,receiptIds:['missing']})).result,'inconclusive');
  assert.equal((await reader.verify({...ctx,receiptIds:[fixture.id],baseline:null})).result,'found_reviewing');
  foreign=true;await assert.rejects(reader.verify(ctx),/incomplete_row/);
  assert.throws(()=>creatorReader(runtime,fixture.platform,{...rules,url:'https://example.test/'}),/invalid_origin/);
});

test('管理列表截断正文时在同一核对页读取稿件详情，与任务快照比对',async t=>{
  const {creatorReader}=await import('../workflow/creator-reader.mjs');
  let present=false,body='完整正文',detailReads=0;
  const {runtime}=await setup(t,route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='zhuanlan.zhihu.com') {
      detailReads++;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>同一标题</h1><section>'+body+'</section>'});
    }
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<b id="ready">已加载</b>'+(present?
      '<article><a href="https://zhuanlan.zhihu.com/p/123?ref=fixture">查看</a><h2>同一标题</h2><p>摘录</p><i>文章</i><em>审核中</em><time datetime="2021-01-02T00:00:00Z"></time></article>':'')});
  });
  const session=await runtime.open(account);
  const reader=creatorReader({open:async()=>session,check:async()=>({platformId:'fixture'})},'zhihu',
    {url:'https://www.zhihu.com/creator/fixture',row:'article',complete:'#ready',type:'i',title:'h2',body:'p',time:'time',status:'em',
      types:{article:'文章'},link:'a',detail:{title:'h1',body:'section'}});
  const expected={platform_id:'fixture',platform:'zhihu'};
  const ctx={account:expected,baseline:await reader.baseline(expected),attempts:[{invoked_at:'2021-01-01T00:00:00Z'}],content:{title:'同一标题',body:'完整正文',type:'article'}};
  present=true;assert.equal((await reader.verify(ctx)).externalId,'123');
  body='其他内容';assert.equal((await reader.verify(ctx)).result,'inconclusive');assert.equal(detailReads,2);
  assert.equal(session.context.pages().length,2);
});

test('关闭运行时等待正在启动的 Chromium 并释放账号目录',async t=>{
  const {runtime}=await setup(t);
  const launcher=runtime.launcher,entered=Promise.withResolvers(),resume=Promise.withResolvers();
  runtime.launcher={launchPersistentContext:async(...args)=>{
    entered.resolve();await resume.promise;return launcher.launchPersistentContext(...args);
  }};
  const opening=runtime.open(account);
  await entered.promise;
  const closing=runtime.close();
  resume.resolve();
  const session=await opening;
  await closing;
  assert.equal(runtime.sessions.size,0);assert.equal(session.page.isClosed(),true);
});
