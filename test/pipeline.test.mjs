import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createStudio } from '../server.mjs';
import JSZip from 'jszip';

const waitFor = async fn => { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待任务状态超时'); };
async function setup(t, browserRuntime, publishAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-test-'));
  let studio;
  let base;
  let token;
  async function start() {
    studio = createStudio({ dataDir: dir, tickMs: 8, demoDelay: 15, browserRuntime, publishAdapter });
    await new Promise(r => studio.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${studio.server.address().port}`;
    token = (await fetch(base + '/api/state').then(r => r.json())).token;
  }
  await start();
  const request = async (path, body, headers = {}) => {
    const res = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const state = async () => (await request('state')).body;
  t.after(async () => {
    await studio.close();
    const target = resolve(dir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('matrix-test-')) throw new Error('拒绝清理非测试目录');
    rmSync(target, { recursive: true, force: true });
  });
  return { request, state, get studio() { return studio; }, restart: async () => { await studio.close(); await start(); }, upload: async () => {
    const res = await fetch(base + '/api/assets', { method:'POST', headers:{'X-Studio-Token':token,'Content-Type':'image/png','X-File-Name':encodeURIComponent('测试.png')}, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=', 'base64') });
    return res.json();
  } };
}
const content = { type:'article', title:'一次创作', body:'完整内容', assetIds:[], versions:{bilibili:{title:'B站专属标题'}} };

for(const finish of ['button','monitor','restart'])test('抖音验证保留原任务且只提交一次：'+finish,async t=>{
 let prepares=0,submits=0,reveals=0,verified=false;
 const runtime={check:async()=>({platformId:'verification-self'}),open:async()=>({}),close:async()=>{},disconnect:async()=>{},reveal:async()=>{reveals++;}};
 const adapter={prepare:async()=>{prepares++;return {};},submit:async(a,c,onClick)=>{submits++;onClick();throw Object.assign(Error('请完成安全验证'),{state:'needs_verification'});},checkResult:async()=>verified?{state:'submitted',receipt:{simulated:false,id:null,evidence:'受控页面验证后成功'}}:{state:'needs_verification'}};
 const app=await setup(t,runtime,adapter),a=(await app.request('accounts',{platform:'douyin',name:'验证流程'})).body.id;await app.request('accounts/'+a+'/check',{});
 app.studio.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run('verification-video','test.mp4','video/mp4',10,new Date().toISOString());
 const c={type:'video',title:'验证流程',body:'正文',assetIds:['verification-video'],publication:{mode:'auto',aiAssisted:false,silent:true}};
 await app.request('dispatch',{content:c,accountIds:[a],requestKey:'verification-'+finish});const job=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_verification'));
 assert.equal((await app.request('jobs/'+job.id+'/retry',{})).status,409);assert.equal((await app.request('jobs/'+job.id+'/confirm',{confirmReal:true})).status,409);assert.equal((await app.request('jobs/'+job.id+'/cancel',{})).status,409);
 assert.equal((await app.request('jobs/'+job.id+'/inspect',{})).status,200);assert.equal(prepares,1);assert.equal(submits,1);assert.ok(reveals>=2);
 if(finish==='restart'){await app.restart();assert.equal((await app.state()).jobs[0].state,'unknown');assert.equal(submits,1);return;}
 assert.equal((await app.request('jobs/'+job.id+'/check-result',{})).body.state,'needs_verification');verified=true;
 if(finish==='button'){assert.equal((await app.request('jobs/'+job.id+'/check-result',{})).body.state,'submitted');}
 else {let state;const end=Date.now()+4500;do{state=(await app.state()).jobs[0].state;if(state==='submitted')break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<end);assert.equal(state,'submitted');}
 assert.equal(submits,1);assert.equal(prepares,1);assert.equal((await app.state()).jobs[0].receipt.id,null);
});

test('两账号分发去重、人工确认和独立模拟回执，取消不影响另一账号', async t => {
  const app = await setup(t);
  const body = { content, accountIds:['demo-zhihu','demo-bilibili'], requestKey:'intent-one' };
  assert.equal((await app.request('dispatch', body)).status, 201);
  assert.equal((await app.request('dispatch', body)).body.reused, true);
  let jobs = (await app.state()).jobs;
  assert.equal(jobs.length, 2);
  const first = await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'awaiting_confirmation'));
  assert.equal((await app.request(`jobs/${first.id}/cancel`, {})).status, 200);
  const second = await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'awaiting_confirmation'));
  assert.notEqual(first.id, second.id);
  assert.equal((await app.request(`jobs/${second.id}/confirm`, {})).status, 200);
  const completed = await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'demo_submitted'));
  assert.equal(completed.receipt.simulated, true); assert.equal(completed.receipt.url, null);
  assert.match(completed.receipt.id, /^DEMO-/);
  assert.equal((await app.request(`jobs/${completed.id}/confirm`, {})).status, 409);
  assert.equal((await app.state()).jobs.find(j => j.id === first.id).state, 'cancelled');
});

test('未登录真实账号不能发布，小红书需要有效会话', async t => {
  const app = await setup(t);
  const actual = (await app.request('accounts', {platform:'zhihu',name:'真实账号'})).body.id;
  const result = await app.request('dispatch', {content,accountIds:[actual],requestKey:'actual'});
  assert.equal(result.status, 422); assert.match(result.body.issues.join(), /尚未识别到登录账号/);
  const xhs = (await app.request('accounts', {platform:'xhs',name:'小红书'})).body.id;
  const suspended = await app.request('validate', {content:{...content,type:'note'},accountIds:[xhs]});
  assert.match(suspended.body.issues.join(), /尚未识别到登录账号/);
  assert.equal((await app.state()).jobs.length, 0);
});

test('提交结果不明不重发、同账号后续任务等待人工处理', async t => {
  const app = await setup(t);
  await app.request('dispatch', {content,accountIds:['demo-zhihu'],requestKey:'unknown',scenario:'unknown'});
  const job = await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'awaiting_confirmation'));
  await app.request(`jobs/${job.id}/confirm`, {});
  await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'unknown'));
  assert.equal((await app.request(`jobs/${job.id}/confirm`, {})).status, 409);
  assert.equal((await app.request(`jobs/${job.id}/cancel`, {})).status, 409);
  await app.request('dispatch', {content,accountIds:['demo-zhihu'],requestKey:'following'});
  await new Promise(r => setTimeout(r, 60));
  assert.equal((await app.state()).jobs.find(j => j.id !== job.id).state, 'queued');
  await app.request(`jobs/${job.id}/resolve`, {});
  await waitFor(async () => (await app.state()).jobs.find(j => j.id !== job.id && j.state === 'awaiting_confirmation'));
});

test('重启恢复：提交中变为待确认，上传中重新排队；素材与草稿持久化', async t => {
  const app = await setup(t);
  const asset = await app.upload(); assert.ok(asset.id);
  await app.request('drafts', {content:{...content,assetIds:[asset.id]}});
  await app.request('dispatch', {content,accountIds:['demo-zhihu','demo-bilibili'],requestKey:'recovery'});
  const jobs = (await app.state()).jobs;
  app.studio.db.prepare("UPDATE jobs SET state='submitting' WHERE id=?").run(jobs[0].id);
  app.studio.db.prepare("UPDATE jobs SET state='uploading' WHERE id=?").run(jobs[1].id);
  await app.restart();
  const saved = await app.state();
  assert.equal(saved.jobs.find(j => j.id === jobs[0].id).state, 'unknown');
  assert.ok(saved.jobs.find(j => j.id === jobs[1].id).events.some(e => e.message.includes('重新排队')));
  assert.equal(saved.assets.length, 1); assert.equal(saved.drafts[0].assetIds[0], asset.id);
});

test('会话失效可人工恢复，写接口拒绝跨站和无令牌请求', async t => {
  const app = await setup(t);
  assert.equal((await app.request('drafts', {content}, {'X-Studio-Token':''})).status, 403);
  assert.equal((await app.request('drafts', {content}, {'Origin':'https://example.com'})).status, 403);
  await app.request('dispatch', {content,accountIds:['demo-zhihu'],requestKey:'login',scenario:'login'});
  const job = await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'needs_login'));
  await app.request(`jobs/${job.id}/resume`, {});
  await waitFor(async () => (await app.state()).jobs.find(j => j.state === 'awaiting_confirmation'));
});

test('接入API：身份核验、重复身份拒绝、停用与真实提交显式确认', async t => {
  const fake = {open:async()=>({}),check:async()=>({platformId:'123'}),disconnect:async()=>{},close:async()=>{}};
  const app = await setup(t,fake);
  const a=(await app.request('accounts',{platform:'bilibili',name:'本人账号'})).body.id;
  assert.equal((await app.request(`accounts/${a}/open`,{})).status,200);
  assert.equal((await app.request(`accounts/${a}/check`,{})).status,200);
  assert.equal((await app.state()).accounts.find(x=>x.id===a).platform_id,'123');
  const b=(await app.request('accounts',{platform:'bilibili',name:'重复账号'})).body.id;
  assert.equal((await app.request(`accounts/${b}/check`,{})).status,409);
  const result=await app.request('dispatch',{content,accountIds:[a],requestKey:'real-intent'});
  assert.equal(result.status,201);
  const job=(await app.state()).jobs[0];
  app.studio.db.prepare("UPDATE jobs SET state='awaiting_confirmation' WHERE id=?").run(job.id);
  assert.equal((await app.request(`jobs/${job.id}/confirm`,{})).status,409);
  assert.equal((await app.request(`accounts/${a}/disconnect`,{})).status,409);
  await app.request(`jobs/${job.id}/cancel`,{});
  assert.equal((await app.request(`accounts/${a}/disconnect`,{})).status,200);
  assert.equal((await app.state()).accounts.find(x=>x.id===a).status,'disconnected');
});

test('富文本服务端过滤活动内容，同时保留基础格式',async t=>{
  const app=await setup(t);
  await app.request('drafts',{content:{...content,bodyHtml:'<h2>标题</h2><p style="text-align:center"><strong>加粗</strong></p><script>bad()</script><img src="x" onerror="bad()"><a href="javascript:bad()">链接</a>'}});
  const saved=(await app.state()).drafts[0];assert.match(saved.bodyHtml,/<strong>加粗/);assert.match(saved.bodyHtml,/text-align:center/);assert.doesNotMatch(saved.bodyHtml,/script|onerror|javascript|src="x"/);
});

test('Word导入转换.docx中的标题、加粗及段落',async t=>{
  const app=await setup(t);
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>导入标题</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗正文</w:t></w:r></w:p></w:body></w:document>');
  const response=await app.request('drafts',{content});assert.equal(response.status,200);
  // The same raw upload route used by the file picker; send no platform credentials.
  const studio=app.studio,origin=`http://127.0.0.1:${studio.server.address().port}`;
  const token=(await app.state()).token;
  const res=await fetch(origin+'/api/import-word',{method:'POST',headers:{'X-Studio-Token':token},body:await zip.generateAsync({type:'nodebuffer'})});
  const result=await res.json();assert.equal(res.status,200);assert.match(result.html,/<strong>加粗正文/);assert.match(result.html,/导入标题/);
});

test('扫码完成直接创建任务：自动补查身份，无需手动核验请求',async t=>{
  let scanned=false;
  const runtime={open:async()=>({}),check:async()=>{if(!scanned)throw Object.assign(Error('等待扫码'),{state:'detecting'});return {platformId:'scanned-user'};},disconnect:async()=>{},close:async()=>{}};
  const app=await setup(t,runtime);
  const a=(await app.request('accounts',{platform:'zhihu',name:'扫码账号'})).body.id;
  await app.request(`accounts/${a}/open`,{});
  scanned=true;
  const response=await app.request('dispatch',{content,accountIds:[a],requestKey:'after-scan'});
  assert.equal(response.status,201);
  await waitFor(async()=> (await app.state()).accounts.find(x=>x.id===a && x.status==='connected'));
});

test('直接发布跳过人工等待，人工模式停下；选项保存为不可变任务快照',async t=>{
  const app=await setup(t);
  const auto={...content,publication:{mode:'auto',aiAssisted:true}};
  await app.request('dispatch',{content:auto,accountIds:['demo-zhihu'],requestKey:'auto-choice'});
  const completed=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='demo_submitted'));
  assert.equal(completed.content.publication.aiAssisted,true);
  assert.ok(!completed.events.some(e=>e.state==='awaiting_confirmation'));
  auto.publication.aiAssisted=false;
  await app.request('dispatch',{content:{...content,publication:{mode:'manual',aiAssisted:false}},accountIds:['demo-bilibili'],requestKey:'manual-choice'});
  const manual=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='awaiting_confirmation'));
  assert.equal(manual.content.publication.mode,'manual');assert.equal(manual.receipt,null);
  assert.equal((await app.state()).jobs.find(j=>j.id===completed.id).content.publication.aiAssisted,true);
});

test('真实自动通道：只提交一次，成功不冒认公开发布，提交超时不重发',async t=>{
  let submits=0, timeout=false;
  const runtime={check:async()=>({platformId:'auto-account'}),open:async()=>({}),close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async()=>({aiDisclosure:{state:'applied',checked:true}}),submit:async(a,c,onClick)=>{submits++;assert.equal(c.publication.aiAssisted,true);onClick();if(timeout)throw Error('timeout');return {simulated:false,id:'fixture-receipt',url:null};}};
  const app=await setup(t,runtime,adapter);
  const a=(await app.request('accounts',{name:'自动发布账号',platform:'zhihu'})).body.id;
  await app.request(`accounts/${a}/check`,{});
  const c={...content,publication:{mode:'auto',aiAssisted:true}};
  await app.request('dispatch',{content:c,accountIds:[a],requestKey:'actual-auto'});
  const done=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.equal(submits,1);assert.equal(done.content.publication.mode,'auto');
  timeout=true;
  await app.request('dispatch',{content:c,accountIds:[a],requestKey:'actual-timeout'});
  const unknown=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='unknown'));
  assert.equal(submits,2);
  assert.equal((await app.request(`jobs/${unknown.id}/confirm`,{confirmReal:true})).status,409);
  await new Promise(r=>setTimeout(r,60));assert.equal(submits,2);
});

test('自动提交前AI处理失败转人工；非法选项不创建任务',async t=>{
  let clicks=0;
  const runtime={check:async()=>({platformId:'blocked-auto'}),open:async()=>({}),close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async()=>({}),submit:async()=>{throw Object.assign(Error('AI控件无法确认'),{state:'needs_manual'});}};
  const app=await setup(t,runtime,adapter);
  const a=(await app.request('accounts',{name:'待处理账号',platform:'zhihu'})).body.id;await app.request(`accounts/${a}/check`,{});
  const c={...content,publication:{mode:'auto',aiAssisted:false}};
  await app.request('dispatch',{content:c,accountIds:[a],requestKey:'blocked-auto'});
  const job=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));
  assert.ok(!job.events.some(e=>e.state==='submitting'));assert.equal(clicks,0);
  const r=await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:'false'}},accountIds:['demo-zhihu'],requestKey:'invalid-options'});
  assert.equal(r.status,422);assert.equal((await app.state()).jobs.length,1);
});

test('修复后重试原有未提交任务，保留原选项；有提交记录的任务不可重发',async t=>{
  let failPrepare=true,submits=0;
  const runtime={check:async()=>({platformId:'retry-user'}),open:async()=>({}),disconnect:async()=>{},close:async()=>{}};
  const adapter={prepare:async()=>{if(failPrepare)throw Object.assign(Error('准备失败'),{state:'needs_manual'});return {};},submit:async(a,c,onClick)=>{submits++;onClick();return {simulated:false,id:'retry-receipt'};}};
  const app=await setup(t,runtime,adapter);
  const a=(await app.request('accounts',{platform:'zhihu',name:'原任务重试'})).body.id;await app.request(`accounts/${a}/check`,{});
  await app.request('dispatch',{requestKey:'retry-before-submit',accountIds:[a],content:{...content,publication:{mode:'auto',aiAssisted:true}}});
  const job=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));
  failPrepare=false;assert.equal((await app.request(`jobs/${job.id}/retry`,{})).status,200);
  const done=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.equal(done.id,job.id);assert.equal(submits,1);assert.equal((await app.state()).jobs.length,1);
  app.studio.db.prepare("UPDATE jobs SET state='needs_manual' WHERE id=?").run(job.id);
  assert.equal((await app.request(`jobs/${job.id}/retry`,{})).status,409);assert.equal(submits,1);
});

test('提交前失败任务不再堵住同账号后续任务',async t=>{
  let broken=true,submits=0;
  const runtime={check:async()=>({platformId:'queue-user'}),open:async()=>({}),close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async()=>{if(broken)throw Object.assign(Error('旧入口失效'),{state:'needs_manual'});return {};},submit:async(a,c,onClick)=>{submits++;onClick();return {simulated:false,id:'queue-receipt'};}};
  const app=await setup(t,runtime,adapter);const a=(await app.request('accounts',{platform:'zhihu',name:'队列回归'})).body.id;await app.request(`accounts/${a}/check`,{});
  const c={...content,publication:{mode:'auto',aiAssisted:true}};
  await app.request('dispatch',{requestKey:'old-failure',content:c,accountIds:[a]});
  const failed=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));
  broken=false;await app.request('dispatch',{requestKey:'new-job',content:c,accountIds:[a]});
  const completed=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.notEqual(completed.id,failed.id);assert.equal(submits,1);assert.equal((await app.state()).jobs.find(j=>j.id===failed.id).state,'needs_manual');
});

test('静默失败后显式接管恢复原文，等待确认而不自动提交',async t=>{
  const sessions=new Map();let submissions=0,prepares=0,repaired=false;
  const runtime={sessions,check:async()=>({platformId:'takeover-user'}),open:async()=>({}),setMode:async(a,headless)=>{const previous=sessions.get(a.id);sessions.set(a.id,{headless});return Boolean(previous&&previous.headless!==headless);},disconnect:async()=>{},close:async()=>{}};
  const adapter={prepare:async(a,c)=>{prepares++;await runtime.setMode(a,c.publication.mode==='auto');if(c.publication.mode==='auto'&&!repaired)throw Object.assign(Error('需要人工处理'),{state:'needs_manual'});return {};},submit:async(a,c,onClick)=>{submissions++;onClick();return {simulated:false};}};
  const app=await setup(t,runtime,adapter);const a=(await app.request('accounts',{name:'接管回归',platform:'zhihu'})).body.id;await app.request(`accounts/${a}/check`,{});
  await app.request('dispatch',{requestKey:'takeover',accountIds:[a],content:{...content,publication:{mode:'auto',aiAssisted:true,silent:true}}});
  const job=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));
  assert.equal(sessions.get(a).headless,true);
  assert.equal((await app.request(`jobs/${job.id}/inspect`,{})).status,200);
  const restored=(await app.state()).jobs[0];assert.equal(restored.state,'awaiting_confirmation');assert.equal(restored.content.publication.mode,'auto');assert.equal(sessions.get(a).headless,false);assert.equal(submissions,0);assert.equal(prepares,2);
  repaired=true;assert.equal((await app.request(`jobs/${job.id}/retry`,{})).status,200);
  await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.equal(submissions,1);assert.equal(sessions.get(a).headless,true);
});

test('打开未知发布入口时进程中断，重启转为结果待确认而不重发',async t=>{
  const app=await setup(t);
  await app.request('dispatch',{requestKey:'opening-crash',content,accountIds:['demo-zhihu']});
  const job=(await app.state()).jobs[0];
  app.studio.db.prepare("UPDATE jobs SET state='opening_settings' WHERE id=?").run(job.id);
  await app.restart();
  assert.equal((await app.state()).jobs[0].state,'unknown');
  assert.equal((await app.request(`jobs/${job.id}/retry`,{})).status,409);
});


test('小红书创建图文任务不被其他发布占用拒绝；同账号按序执行且意图去重',async t=>{
  let releasePrepare,started=false;const seen=[];
  const runtime={check:async a=>({platformId:'queue-'+a.id}),open:async()=>({}),close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async(a,c)=>{seen.push(c.title);if(!started){started=true;await new Promise(r=>releasePrepare=r);}return {};},submit:async(a,c,onClick)=>{onClick();return {simulated:false};}};
  const app=await setup(t,runtime,adapter);t.after(()=>releasePrepare?.());
  const a=(await app.request('accounts',{platform:'xhs',name:'图文排队'})).body.id;await app.request('accounts/'+a+'/check',{});
  const img=(await app.upload()).id;
  const c={type:'note',title:'图文一',body:'正文',assetIds:[img],publication:{mode:'auto',aiAssisted:false}};
  assert.equal((await app.request('dispatch',{content:c,accountIds:[a],requestKey:'occupied-1'})).status,201);
  await waitFor(()=>started);
  const second={content:{...c,title:'图文二'},accountIds:[a],requestKey:'occupied-2'};
  assert.equal((await app.request('dispatch',second)).status,201);
  assert.equal((await app.request('dispatch',second)).body.reused,true);
  assert.deepEqual(seen,['图文一']);
  releasePrepare();
  await waitFor(async()=> (await app.state()).jobs.filter(j=>j.state==='submitted').length===2);
  assert.deepEqual(seen,['图文一','图文二']);
});

test('账号同步期间新图文任务立即入队，后台按钮串行等待而不返回占用错误',async t=>{
  let hold=false,releaseCheck,started=false;const actions=[];
  const runtime={check:async a=>{if(hold){started=true;await new Promise(r=>releaseCheck=r);}return {platformId:'scan-'+a.id};},open:async a=>{actions.push(a.id);return {};},close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async()=>({}),submit:async(a,c,onClick)=>{onClick();return {simulated:false};}};
  const app=await setup(t,runtime,adapter);t.after(()=>releaseCheck?.());
  const a=(await app.request('accounts',{platform:'xhs',name:'同步中图文'})).body.id;
  const b=(await app.request('accounts',{platform:'douyin',name:'并行后台请求'})).body.id;
  await app.request('accounts/'+a+'/check',{});hold=true;
  const checking=app.request('accounts/'+a+'/check',{});await waitFor(()=>started);
  const opening=app.request('accounts/'+b+'/open',{});
  const img=(await app.upload()).id;
  assert.equal((await app.request('dispatch',{content:{type:'note',title:'同步时创建',body:'正文',assetIds:[img]},accountIds:[a],requestKey:'syncing-note'})).status,201);
  assert.equal((await app.state()).jobs[0].state,'queued');assert.equal(actions.includes(b),false);
  hold=false;releaseCheck();assert.equal((await checking).status,200);assert.equal((await opening).status,200);
  await waitFor(async()=> (await app.state()).jobs[0].state==='awaiting_confirmation');
});


test('上传准备逐步记录等待位置，步骤超时释放执行器并允许后续任务继续',async t=>{
  let broken=true;
  const runtime={check:async()=>({platformId:'stage-user'}),open:async()=>({}),close:async()=>{},disconnect:async()=>{}};
  const adapter={prepare:async(a,c,hooks)=>{hooks.onProgress('上传素材到平台');if(broken)throw Object.assign(Error('fixture timeout'),{name:'TimeoutError'});hooks.onProgress('填写正文或视频简介');return {};},submit:async(a,c,onClick,hooks)=>{hooks.onProgress('提交前再次检查账号身份');onClick();hooks.onProgress('已执行最终提交，等待平台回执');return {simulated:false};}};
  const app=await setup(t,runtime,adapter);const a=(await app.request('accounts',{platform:'xhs',name:'分步诊断'})).body.id;await app.request('accounts/'+a+'/check',{});
  const img=(await app.upload()).id,c={type:'note',title:'诊断任务',body:'正文',assetIds:[img],publication:{mode:'auto',aiAssisted:true}};
  await app.request('dispatch',{requestKey:'stage-timeout',accountIds:[a],content:c});
  const failed=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));
  assert.match(failed.events.at(-1).message,/上传素材到平台未完成（等待超时）/);assert.ok(!failed.events.some(e=>e.state==='submitting'));
  broken=false;await app.request('dispatch',{requestKey:'stage-next',accountIds:[a],content:c});
  const done=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.notEqual(done.id,failed.id);assert.ok(done.events.some(e=>e.message==='填写正文或视频简介'));assert.ok(done.events.some(e=>e.state==='submitting'&&e.message==='已执行最终提交，等待平台回执'));
});


test('账号浏览器关闭后人工接管仍恢复原任务，不因旧activeTasks记录跳过准备',async t=>{
 const sessions=new Map();let prepares=0,submits=0;
 const runtime={sessions,check:async()=>({platformId:'closed-session-self'}),open:async a=>{sessions.set(a.id,{headless:false});return {};},setMode:async(a,headless)=>{const previous=sessions.get(a.id);sessions.set(a.id,{headless});return Boolean(previous&&previous.headless!==headless);},close:async()=>{},disconnect:async()=>{}};
 const adapter={prepare:async(a,c)=>{prepares++;if(c.publication.mode==='auto')throw Object.assign(Error('待接管'),{state:'needs_manual'});return {};},submit:async()=>{submits++;}};
 const app=await setup(t,runtime,adapter);const a=(await app.request('accounts',{platform:'xhs',name:'关闭后接管'})).body.id;await app.request('accounts/'+a+'/check',{});const image=(await app.upload()).id;
 await app.request('dispatch',{requestKey:'closed-session',accountIds:[a],content:{type:'note',title:'原任务',body:'正文',assetIds:[image],publication:{mode:'auto',aiAssisted:true}}});
 const job=await waitFor(async()=> (await app.state()).jobs.find(j=>j.state==='needs_manual'));sessions.delete(a);
 assert.equal((await app.request('jobs/'+job.id+'/inspect',{})).status,200);assert.equal((await app.state()).jobs[0].state,'awaiting_confirmation');assert.equal(prepares,2);assert.equal(submits,0);
});
