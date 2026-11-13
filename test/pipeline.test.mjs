import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createStudio } from '../server.mjs';
import JSZip from 'jszip';

const waitFor = async (fn,tries=150) => { for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待任务状态超时'); };
async function setup(t, browserRuntime, publishAdapter, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-test-'));
  let studio;
  let base;
  let token;
  async function start() {
    studio = createStudio({ dataDir: dir, tickMs: 8, demoDelay: 15, browserRuntime, publishAdapter, ...options });
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
  return { dir, request, state, get studio() { return studio; }, restart: async () => { await studio.close(); await start(); }, upload: async () => {
    const res = await fetch(base + '/api/assets', { method:'POST', headers:{'X-Studio-Token':token,'Content-Type':'image/png','X-File-Name':encodeURIComponent('测试.png')}, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=', 'base64') });
    return res.json();
  } };
}
const content = { type:'article', title:'一次创作', body:'完整内容', assetIds:[], versions:{bilibili:{title:'B站专属标题'}} };

for(const scenario of ['complete','stop'])test('任务目标坐标恢复经服务端快照、视觉模型、标准复核及原提交门禁：'+scenario,async t=>{
  const {chromium}=await import('playwright'),{observeRecovery}=await import('../workflow/recovery-page.mjs'),{observeVisualRecovery}=await import('../workflow/visual-recovery.mjs');
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<input id="title"><section><span>自主声明</span><button type="button" id="options" aria-haspopup="listbox" onclick="document.querySelector('#portal').hidden=false">打开内容说明</button></section><div id="portal" hidden><div id="ai" onclick="window.ready=true;document.querySelector('#portal').hidden=true">内容由AI生成</div></div><button type="button" id="publish" onclick="window.sent=(window.sent||0)+1">发布</button>`}));await page.goto('https://zhuanlan.zhihu.com/write');
  let calls=0,visual=0,waiting=false,answer;
  const model=async o=>{calls++;if(!o.coordinateMode)return {action:'revalidate',token:o.token};visual++;assert.deepEqual(o.goal,{kind:'declaration',desired:'AI辅助创作'});if(scenario==='stop'){waiting=true;await new Promise(r=>answer=r);}if(await page.evaluate(()=>window.ready))return {action:'revalidate',token:o.token};const box=await page.locator(await page.locator('#portal').isVisible()?'#ai':'#options').boundingBox();return {action:'click_at',token:o.token,goal:o.goal.kind,x:Math.floor(box.x+box.width/2),y:Math.floor(box.y+box.height/2)};};model.visionAvailable=true;
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({page}),close:async()=>{},observeRecovery:(a,e)=>observeRecovery(page,['zhuanlan.zhihu.com'],e),observeVisualRecovery:(a,e)=>observeVisualRecovery(page,['zhuanlan.zhihu.com'],e)};
  const adapter={rule:()=>({title:'#title',url:'https://zhuanlan.zhihu.com/write'}),prepare:async(a,c,h)=>{h.onProgress('设置平台 AI 创作声明');if(!await page.evaluate(()=>window.ready))throw Object.assign(Error('声明入口改变'),{state:'needs_manual'});},submit:async(a,c,gate)=>{assert.ok(await page.evaluate(()=>window.ready));await gate();await page.locator('#publish').click();return {id:'coordinate-controlled'};}};
  const app=await setup(t,runtime,adapter,{model,recoveryLimits:{maxCalls:6}});const account=(await app.request('accounts',{platform:'zhihu',name:'坐标恢复受控账号'})).body.id;await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[account],requestKey:'coordinates-'+scenario,publicationPolicy:{recovery:{visualEnabled:true,structuredCallsBeforeVisual:1}}});
  if(scenario==='stop'){await waitFor(()=>waiting,800);const job=(await app.state()).jobs.find(j=>j.account_id===account);await app.request('publications/'+job.id+'/stop',{expectedVersion:job.publicationIntent.version});answer();await waitFor(async()=>(await app.state()).jobs.find(j=>j.id===job.id).state==='cancelled');assert.equal(await page.evaluate(()=>!!window.ready),false);assert.equal(await page.evaluate(()=>window.sent||0),0);return;}
  const job=await waitFor(async()=>(await app.state()).jobs.find(j=>j.account_id===account&&['submitted','needs_manual','waiting_human'].includes(j.state)),1000);assert.equal(job.state,'submitted',JSON.stringify(job.events));assert.equal(calls,4);assert.equal(visual,3);assert.equal(job.usedAttempts,1);assert.equal(await page.evaluate(()=>window.sent),1);assert.equal(job.events.filter(e=>e.message.includes('已点击')).length,2);
});

test('删除已保存任务：取消、过期版本及鉴权保护，保留运行快照与成品并停止后续调度',async t=>{
  let ms=Date.UTC(2026,10,12),release,writing=false;
  const app=await setup(t,undefined,undefined,{clock:()=>new Date(ms).toISOString(),writer:async()=>{writing=true;await new Promise(resolve=>release=resolve);return {title:'保留成品',body:'原运行生成内容',assetIds:[]};}});
  const spec={topic:'待删除的定时任务',style:'简洁',facts:'给定事实',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'manual',maxCalls:1,schedule:{startAt:new Date(ms+60000).toISOString(),intervalSeconds:60}};
  const saved=(await app.request('task-templates',{enabled:true,spec})).body;
  const run=(await app.request('task-templates/'+saved.id+'/run',{requestKey:'retained-run'})).body;await waitFor(()=>writing);
  const edited=(await app.request('task-templates/'+saved.id,{spec,enabled:true,expectedVersion:saved.version})).body;
  assert.equal((await app.request('task-templates/'+saved.id+'/delete',{expectedVersion:saved.version})).status,409);
  assert.equal((await app.request('task-templates/'+saved.id+'/delete',{expectedVersion:edited.version},{'X-Studio-Token':'wrong'})).status,403);
  assert.equal((await app.request('task-templates/'+saved.id+'/delete',{expectedVersion:edited.version},{Origin:'https://other.example'})).status,403);
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const p=await browser.newPage();p.setDefaultTimeout(5000);
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#macros');await p.locator('[data-macro-delete]').click();await p.locator('#cancel-delete-template').click();
  assert.equal((await app.request('task-templates')).body.length,1);
  await p.locator('[data-macro-delete]').click();await p.locator('#confirm-delete-template').click();await p.locator('[data-macro-delete]').waitFor({state:'detached'});
  assert.equal((await app.request('task-templates')).body.length,0);assert.equal((await app.request('runs/'+run.id)).body.targets[0].state,'generating');
  release();await waitFor(async()=>(await app.request('runs/'+run.id)).body.targets[0].state==='dispatched');
  ms+=180000;await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await app.request('runs')).body.length,1);
  await p.reload();await p.locator('[data-macro-details]').waitFor();assert.ok((await p.locator('.task-history').last().innerText()).includes(spec.topic));
  const archived=(await app.request('runs/'+run.id)).body;assert.equal(archived.snapshot.topic,spec.topic);assert.equal(archived.targets[0].artifact.title,'保留成品');
  assert.equal((await app.request('task-templates/'+saved.id+'/run',{requestKey:'deleted-cannot-run'})).status,404);
  const toolTemplate=(await app.request('task-templates',{enabled:true,spec})).body;
  assert.equal((await app.request('agent/actions',{name:'delete_template',arguments:{id:toolTemplate.id,expectedVersion:toolTemplate.version}})).body.result.deleted,true);
  const restTemplate=(await app.request('task-templates',{enabled:true,spec})).body;
  const result=await fetch('http://127.0.0.1:'+app.studio.server.address().port+'/api/task-templates/'+restTemplate.id+'?expectedVersion='+restTemplate.version,{method:'DELETE',headers:{'X-Studio-Token':(await app.state()).token}});
  assert.equal(result.status,200);assert.equal((await result.json()).deleted,true);
});

test('随机等待期间停止发布，迟到进度不能恢复取消状态，也不能进入提交门禁',async t=>{
  const {operationPacer}=await import('../browser-pace.mjs');const pacer=operationPacer({minMs:5000,maxMs:5000});t.after(()=>pacer.close());
  let waiting=false,finished=false,clicks=0;
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({}),close:async()=>{}};
  const adapter={prepare:async(a,c,hooks)=>{waiting=true;try{await pacer.wait({isClosed:()=>false},'field',{isActive:hooks.isActive});}finally{hooks.onProgress('迟到的填写进度');finished=true;}},submit:async(a,c,gate)=>{await gate();clicks++;return {};}};
  const app=await setup(t,runtime,adapter),account=(await app.request('accounts',{platform:'zhihu',name:'节奏停止测试'})).body.id;await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[account],requestKey:'paced-stop'});await waitFor(()=>waiting);
  const job=(await app.state()).jobs.find(j=>j.account_id===account);await app.request('publications/'+job.id+'/stop',{expectedVersion:job.publicationIntent.version});await waitFor(()=>finished);
  const after=(await app.state()).jobs.find(j=>j.id===job.id);assert.equal(after.state,'cancelled');assert.equal(after.usedAttempts,0);assert.equal(clicks,0);assert.ok(!after.events.some(e=>e.message==='迟到的填写进度'));
});

for(const scenario of ['complete','stop','missing_vision'])test('账号标签页分级视觉恢复、共享预算与停止门禁：'+scenario,async t=>{
  const {chromium}=await import('playwright'),{observeRecovery}=await import('../workflow/recovery-page.mjs'),{observeVisualRecovery}=await import('../workflow/visual-recovery.mjs');
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<section id="blocker"><p>private-account-data</p><button type="button" onclick="this.parentElement.remove()">我知道了</button></section><button type="button" onclick="window.published=(window.published||0)+1">发布</button>'}));
  await page.goto('https://zhuanlan.zhihu.com/write');
  let calls=0,clicks=0,visual=0,visualPending,answer;
  const model=async observation=>{
    calls++;
    if(observation.mode==='visual') {
      visual++;assert.ok(observation.screenshot.startsWith('data:image/png;base64,'));
      assert.ok(!observation.targets.some(t=>t.label.includes('发布')));
      if(scenario==='stop'){visualPending=true;await new Promise(resolve=>answer=resolve);}
      if(observation.targets.length)return {action:'click',token:observation.token,targetId:observation.targets[0].id};
    }
    return {action:'revalidate',token:observation.token};
  };
  model.visionAvailable=scenario!=='missing_vision';
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({page}),close:async()=>{},
    observeRecovery:()=>observeRecovery(page,['zhuanlan.zhihu.com']),observeVisualRecovery:()=>observeVisualRecovery(page,['zhuanlan.zhihu.com'])};
  const adapter={prepare:async()=>{if(await page.locator('#blocker').count())throw Error('unknown popover');},submit:async(a,c,gate)=>{await gate();clicks++;await page.getByRole('button',{name:'发布',exact:true}).click();return {id:'controlled-visual'};}};
  const app=await setup(t,runtime,adapter,{model,recoveryLimits:{maxCalls:4,maxMicros:4,callMicros:1}});
  const account=(await app.request('accounts',{platform:'zhihu',name:'视觉恢复账号'})).body.id;await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[account],requestKey:'visual-recovery',publicationPolicy:{recovery:{visualEnabled:true,structuredCallsBeforeVisual:2}}});
  if(scenario==='stop') {
    await waitFor(()=>visualPending,500);const job=(await app.state()).jobs.find(j=>j.account_id===account);
    await app.request('publications/'+job.id+'/stop',{expectedVersion:job.publicationIntent.version});answer();
    await waitFor(async()=>(await app.state()).jobs.find(j=>j.account_id===account).state==='cancelled');
    assert.equal(await page.locator('#blocker').count(),1);assert.equal(clicks,0);return;
  }
  const job=await waitFor(async()=>(await app.state()).jobs.find(j=>j.account_id===account&&j.state===(scenario==='complete'?'submitted':'needs_manual')),500);
  if(scenario==='complete') {
    assert.equal(calls,4);assert.equal(visual,2);assert.equal(clicks,1);assert.equal(job.usedAttempts,1);
    assert.equal(job.publicationIntent.recovery.recovery_level,'visual');assert.equal(job.publicationIntent.recovery.visual_calls,2);
    assert.equal(job.publicationIntent.recovery.reserved_micros,4);assert.equal(await page.evaluate(()=>window.published),1);
    assert.ok(job.events.some(e=>e.message.includes('已升级')));
    await app.restart();const persisted=(await app.state()).jobs.find(j=>j.id===job.id);assert.equal(persisted.publicationIntent.recovery.visual_calls,2);assert.equal(calls,4);
  }else {assert.equal(job.publicationIntent.recovery.reason,'missing_visual_model');assert.equal(calls,2);assert.equal(clicks,0);assert.equal(visual,0);}
});

test('同一模型配置可通过两次独立对话完成规划与写作，不共享恢复对话',async t=>{
  const http=await import('node:http'),calls=[];
  const provider=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls.push(body);
    const output=calls.length===1?{prompt:'依据给定事实写作，遵守素材ID范围。'}:{title:'同模型独立写作',body:'给定事实',assetIds:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const app=await setup(t),saved=(await app.request('model-settings',{endpoint:'http://127.0.0.1:'+provider.address().port+'/chat',model:'same-model'})).body;
  const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const p=await browser.newPage();await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#macros');
  await p.locator('[name=separateWriter]').check();assert.equal(await p.locator('[name=generationModelId]').inputValue(),saved.activeId);
  const template=(await app.request('task-templates',{enabled:true,spec:{topic:'同模型分工',style:'简洁',facts:'给定事实',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'manual',maxCalls:2,editorialReview:false,generationModelId:saved.activeId}})).body;
  const run=(await app.request('task-templates/'+template.id+'/run',{requestKey:'same-profile'})).body;
  const detail=await waitFor(async()=>{const detail=(await app.request('runs/'+run.id)).body;return detail.targets[0].state==='dispatched'&&detail;});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.model==='same-model'&&c.messages.length===2));
  assert.notEqual(calls[0].messages[0].content,calls[1].messages[0].content);
  assert.equal(detail.targets[0].artifact.agentModelId,detail.targets[0].artifact.generationModelId);
});

test('图片失败原因写入日志并交给模型，受控图片恢复后仍从原提交门禁发布',async t=>{
  let prepares=0,clicks=0,received;
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({}),close:async()=>{},observeRecovery:async(a,editor)=>{
    received=editor;return {observation:{token:'image-token',failureCode:editor.failureCode,actions:['retry_image_upload','human']},perform:async action=>action==='retry_image_upload'};
  }};
  const adapter={rule:()=>({title:'textarea',url:'https://zhuanlan.zhihu.com/write'}),prepare:async()=>{if(++prepares===1)throw Object.assign(Error('正文图片 1/1 上传失败'),{state:'needs_manual',code:'image_upload_failed'});return {};},
    submit:async(a,c,gate)=>{await gate();clicks++;return {id:'controlled-image-retry'};}};
  const app=await setup(t,runtime,adapter,{model:async observation=>({action:'retry_image_upload',token:observation.token})});
  const account=(await app.request('accounts',{platform:'zhihu',name:'受控图片恢复'})).body.id;await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[account],requestKey:'image-failure'});
  const job=await waitFor(async()=>(await app.state()).jobs.find(j=>j.state==='submitted'));
  assert.equal(received.failureCode,'image_upload_failed');assert.equal(prepares,2);assert.equal(clicks,1);assert.equal(job.usedAttempts,1);
  assert.ok(job.events.some(e=>e.message.includes('正文图片 1/1 上传失败')));
});

test('停止两模型任务时迟到的 agent 提示词不触发写作模型，重启不重复调用',async t=>{
  const http=await import('node:http');let calls=0,reply;
  const provider=http.createServer(async(req,res)=>{
    for await(const chunk of req){}calls++;
    reply=()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"prompt":"迟到提示词"}'}}]}));};
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const app=await setup(t),endpoint='http://127.0.0.1:'+provider.address().port+'/chat';
  await app.request('model-settings',{endpoint,model:'agent'});
  const writer=(await app.request('model-settings',{create:true,activate:false,endpoint,model:'writer'})).body.savedId;
  const saved=(await app.request('task-templates',{enabled:true,spec:{topic:'可停止',style:'简洁',facts:'给定事实',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'manual',editorialReview:false,generationModelId:writer,maxCalls:2}})).body;
  const run=(await app.request('task-templates/'+saved.id+'/run',{requestKey:'stop-between-models'})).body;
  await waitFor(()=>reply);await app.request('runs/'+run.id+'/stop',{});reply();
  await app.restart();assert.equal(calls,1);assert.equal((await app.state()).jobs.length,0);
  assert.equal((await app.request('runs/'+run.id)).body.targets[0].state,'cancelled');
});

test('另一写作 LLM 接收 agent 生成的提示词，两次调用受统一预算约束且保留成品提示词',async t=>{
  const http=await import('node:http'),calls=[];
  const provider=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);calls.push({body,key:req.headers.authorization});
    const output=body.model==='agent'?{prompt:'请依据事实写一篇结构清楚的文章，保持素材 ID 限制。'}:{title:'独立写作模型稿件',body:'事实正文',assetIds:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const app=await setup(t,undefined,undefined,{writerCallMicros:10}),endpoint='http://127.0.0.1:'+provider.address().port+'/chat';
  const first=(await app.request('model-settings',{endpoint,model:'agent',name:'规划',key:'agent-key'})).body;
  const second=(await app.request('model-settings',{create:true,activate:false,endpoint,model:'writer',name:'写作',key:'writer-key'})).body;
  assert.equal(second.activeId,first.activeId);assert.equal(second.profiles.length,2);
  const make=async(maxCalls,maxMicros)=>{
    const spec={topic:'分工写作',style:'简洁',facts:'仅使用本机事实',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'manual',editorialReview:false,generationModelId:second.savedId,maxCalls,maxMicros};
    const saved=(await app.request('task-templates',{enabled:true,spec})).body;
    return (await app.request('task-templates/'+saved.id+'/run',{requestKey:'generation'})).body.id;
  };
  const limited=await make(1,20);
  await waitFor(async()=>(await app.request('runs/'+limited)).body.targets[0].reason==='budget_exhausted');assert.equal(calls.length,0);
  const expensive=await make(2,10);
  await waitFor(async()=>(await app.request('runs/'+expensive)).body.targets[0].reason==='cost_limit');assert.equal(calls.length,0);
  const id=await make(2,20);
  const run=await waitFor(async()=>{const value=(await app.request('runs/'+id)).body;return value.targets[0].state==='dispatched'&&value;});
  assert.deepEqual(calls.map(c=>[c.body.model,c.key]),[['agent','Bearer agent-key'],['writer','Bearer writer-key']]);
  assert.equal(JSON.parse(calls[1].body.messages[1].content).generatedPrompt,run.targets[0].artifact.generationPrompt);
  assert.equal(run.calls,2);assert.equal(run.reserved_micros,20);assert.equal(run.targets[0].artifact.generationModelId,second.savedId);
  await app.restart();assert.equal((await app.state()).modelSettings.profiles.length,2);assert.equal(calls.length,2);
});

test('任务页面保存多模型并测试，按日期过滤素材，参考区上传保存并自动选中且保留输入',async t=>{
  const http=await import('node:http');let probes=0;
  const provider=http.createServer(async(req,res)=>{for await(const chunk of req){}probes++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const app=await setup(t),old=(await app.upload()).id;await app.request('assets/'+old,{archiveDate:'2026-01-01'});
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(8000);
  const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#macros');
  const form=p.locator('#macro-form'),model=p.locator('#model-settings-form');
  await form.locator('[name=topic]').fill('上传参考资料任务');await form.locator('[name=style]').fill('依据资料写作');await form.locator('[name=facts]').fill('保留我的事实和输入');
  await model.locator('[name=endpoint]').fill('http://127.0.0.1:'+provider.address().port+'/chat');await model.locator('[name=model]').fill('agent-model');
  await model.getByRole('button',{name:'保存并测试连接'}).click();await p.locator('#model-test-result').filter({hasText:'连接成功'}).waitFor();assert.equal(probes,1);
  const active=(await app.state()).modelSettings.activeId;
  await p.locator('#model-new').click();await model.locator('[name=endpoint]').fill('http://127.0.0.1:'+provider.address().port+'/chat');await model.locator('[name=model]').fill('writer-model');
  await model.getByRole('button',{name:'保存模型配置',exact:true}).click();await p.locator('#model-test-result').filter({hasText:'配置已保存'}).waitFor();
  const config=(await app.state()).modelSettings;assert.equal(config.profiles.length,2);assert.equal(config.activeId,active);
  const writer=config.profiles.find(m=>m.id!==active).id;
  await form.locator('[name=separateWriter]').check();await form.locator('[name=generationModelId]').selectOption(writer);
  await p.locator('#task-upload-date').fill('2026-11-12');
  await p.locator('#task-reference-files').setInputFiles({name:'参考资料.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64')});
  await p.locator('#task-upload-status').filter({hasText:'已保存到素材库并选中 1'}).waitFor();
  assert.equal(await form.locator('[name=asset]:checked').count(),1);assert.equal(await form.locator('[name=facts]').inputValue(),'保留我的事实和输入');
  const assets=(await app.state()).assets;assert.equal(assets.length,2);assert.equal(assets.find(a=>a.name==='参考资料.png').archiveDate,'2026-11-12');
  await p.locator('#task-source-from').fill('2026-11-12');await p.locator('#task-source-to').fill('2026-11-12');assert.equal(await p.locator('.task-source:visible').count(),1);
  await p.locator('#task-source-to').fill('2026-01-01');assert.equal(await p.locator('.task-source:visible').count(),0);assert.equal(await form.locator('[name=asset]:checked').count(),1);
  await p.locator('#task-source-clear').click();assert.equal(await p.locator('.task-source:visible').count(),2);
  await form.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();
  await p.getByText('恢复、预算与发布后核对',{exact:true}).click();
  await form.locator('[name=visualRecovery]').check();await form.locator('[name=structuredCalls]').fill('1');
  await p.locator('.task-model').scrollIntoViewIfNeeded();await p.screenshot({path:'docs/任务页面-多模型与测试.png'});
  await form.locator('[name=facts]').scrollIntoViewIfNeeded();await p.screenshot({path:'docs/任务页面-参考上传与写作模型.png'});
  await form.getByRole('button',{name:'保存任务',exact:true}).click();await p.locator('[data-macro-edit]').waitFor();
  const spec=(await app.request('task-templates')).body[0].spec;assert.equal(spec.generationModelId,writer);assert.equal(spec.assetIds.length,1);
  assert.equal(spec.publicationPolicy.recovery.visualEnabled,true);assert.equal(spec.publicationPolicy.recovery.structuredCallsBeforeVisual,1);
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});

test('用户保存 LLM 后即时生成，切换模型不重启，凭证只发给当前模型端点',async t=>{
  const http=await import('node:http');const calls=[];
  const provider=http.createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    calls.push({body:JSON.parse(data),key:req.headers.authorization});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'可配置模型稿件',body:'仅使用给定事实',assetIds:[]})}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const app=await setup(t),endpoint='http://127.0.0.1:'+provider.address().port+'/chat/completions';
  for(const name of ['model-a','model-b']) {
    assert.equal((await app.request('model-settings',{endpoint,model:name,key:name==='model-a'?'local-test-key':''})).status,200);
    const saved=await app.request('task-templates',{enabled:true,spec:{topic:name,style:'简洁',facts:'本机事实',assetIds:[],targets:[{accountId:'demo-zhihu',type:'article'}],mode:'manual',maxCalls:1}});
    const run=(await app.request('task-templates/'+saved.body.id+'/run',{requestKey:name})).body;
    await waitFor(async()=>(await app.request('runs/'+run.id)).body.targets[0].state==='dispatched',400);
  }
  assert.deepEqual(calls.map(c=>c.body.model),['model-a','model-b']);assert.ok(calls.every(c=>c.key==='Bearer local-test-key'));
});

test('任务卡片筛选保留选择、模型配置持久化且不泄密、素材生成可仅使用画面',async t=>{
  let observed;
  const app=await setup(t,undefined,undefined,{writer:async input=>{observed=input;return {title:'画面生成文章',body:'依据选定图片生成正文',assetIds:[input.assets[0].id]};}});
  const asset=(await app.upload()).id;
  const {chromium}=await import('playwright');const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(8000);
  const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#macros');
  await p.getByRole('heading',{name:'任务',exact:true}).waitFor();
  const f=p.locator('#macro-form'),model=p.locator('#model-settings-form');
  await f.locator('[name=topic]').fill('仅用选定素材');await f.locator('[name=style]').fill('严谨中文');
  await model.locator('[name=endpoint]').fill('http://127.0.0.1:12345/chat/completions');await model.locator('[name=model]').fill('my-model');
  await model.locator('[name=key]').fill('local-secret-never-returned');await model.locator('[name=vision]').check();await model.getByRole('button',{name:'保存模型配置',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('.task-model .badge').textContent==='已配置');
  assert.equal(await f.locator('[name=topic]').inputValue(),'仅用选定素材');
  const settings=(await app.request('model-settings')).body;assert.equal(settings.hasKey,true);assert.equal(settings.vision,true);
  assert.ok(!JSON.stringify(await app.state()).includes('local-secret-never-returned'));
  assert.equal((await app.request('model-settings',{endpoint:'https://user:secret@example.com/chat',model:'bad'})).status,422);
  await f.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();
  await p.locator('[data-task-platform=bilibili]').click();assert.equal(await f.locator('[name=target]:checked').count(),1);
  assert.equal(await p.locator('[data-task-account=demo-zhihu]').isVisible(),false);
  await p.locator('[data-task-platform=""]').click();assert.equal(await p.locator('[data-task-account=demo-zhihu]').isVisible(),true);
  await f.locator('[name=asset]').check();await p.locator('#task-source-search').fill('不存在');assert.equal(await p.locator('.task-source:visible').count(),0);
  assert.equal(await f.locator('[name=asset]:checked').count(),1);await p.locator('#task-source-search').fill('');
  await f.locator('[name=sourceMode]').selectOption('content');
  await p.locator('.task-model').scrollIntoViewIfNeeded();await p.screenshot({path:'docs/任务页面-模型配置.png'});
  await p.locator('[data-task-account=demo-zhihu]').scrollIntoViewIfNeeded();await p.screenshot({path:'docs/任务页面-账号与素材.png'});
  await f.locator('[name=reviewBeforePublish]').uncheck();await f.getByRole('button',{name:'保存任务',exact:true}).click();await p.locator('[data-macro-run]').click();
  await waitFor(async()=>!!observed,500);
  assert.equal(observed.sourceMode,'content');assert.equal(observed.facts,'');assert.equal(observed.assets[0].id,asset);
  assert.match(observed.assets[0].previews[0].url,/^data:image\/jpeg;base64,/);
  await waitFor(async()=>(await app.state()).jobs.length===1,500);
  const run=(await app.request('runs/'+(await app.state()).macroRuns[0].id)).body;
  assert.match(run.targets[0].artifact.bodyHtml,/<img src="\/media\//);
  await p.setViewportSize({width:390,height:844});await p.locator('h1').scrollIntoViewIfNeeded();
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  await app.restart();assert.equal((await app.request('model-settings')).body.model,'my-model');
});

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
  const conflict = await app.request('dispatch', {...body, content:{...content,title:'不同稿件'}});
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.reasonCode,'request_key_conflict');
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

test('核对策略逐账号持久化，校验冲突、停止和未接入通道', async t => {
  const app = await setup(t);
  const request = {requestKey:'snapshot-policy',content:{...content,publication:{mode:'auto',aiAssisted:false}},
    accountIds:['demo-zhihu','demo-bilibili'],publicationPolicy:{verification:{enabled:true,firstCheckAfterSeconds:60},
    retry:{allowAbsentAfterTimeout:true,maxResends:2,cooldownSeconds:[30,60]}}};
  const invalid = await app.request('dispatch',{...request,publicationPolicy:{retry:{maxResends:2}}});
  assert.equal(invalid.status,422);
  assert.equal(invalid.body.reasonCode,'invalid_policy');
  assert.equal((await app.request('dispatch',request)).status,201);
  assert.equal((await app.request('dispatch',request)).body.reused,true);
  assert.equal((await app.request('dispatch',{...request,publicationPolicy:{}})).status,409);
  await waitFor(async()=>(await app.state()).jobs.every(j=>j.state==='demo_submitted'));
  await app.restart();
  const [first,second] = (await app.state()).jobs;
  assert.deepEqual(first.publicationIntent.policy.retry.cooldownSeconds,[30,60]);
  const stop = 'publications/'+first.id+'/stop';
  assert.equal((await app.request(stop,{expectedVersion:0})).status,409);
  assert.equal((await app.request(stop,{expectedVersion:first.publicationIntent.version})).body.status,'stopped');
  app.studio.db.prepare("UPDATE publication_intents SET next_check_at='2000-01-01' WHERE job_id=?").run(second.id);
  await waitFor(async()=>(await app.state()).jobs.find(j=>j.id===second.id)?.publicationIntent.status==='unsupported_verifier');
  assert.equal(app.studio.db.prepare('SELECT COUNT(*) AS n FROM verification_observations').get().n,1);
  assert.ok((await app.state()).jobs.every(j=>j.usedAttempts===1));
});

for (const scenario of ['limit','late','stop','duplicate']) test('受控查稿重发：'+scenario,async t=>{
  let ms=Date.UTC(2026,0,1), clicks=0, reads=0;
  const pending = Promise.withResolvers();
  const runtime={check:async()=>({platformId:'known-owner'}),close:async()=>{},open:async()=>({})};
  let page;
  if (scenario==='limit') {
    const {chromium}=await import('playwright');
    const browser=await chromium.launch({channel:'chrome',headless:true});
    t.after(()=>browser.close());
    page=await browser.newPage();
    await page.setContent('<button onclick="document.body.dataset.count=Number(document.body.dataset.count||0)+1">提交</button>');
  }
  const adapter={prepare:async()=>({}),submit:async(a,c,gate)=>{
    await gate();
    if(page) await page.getByRole('button',{name:'提交'}).click();
    clicks++;
    throw Error('timeout');
  }};
  const verifier=async ({attempts})=>{
    reads++;
    const accountIdentity={verified:true,observed:'known-owner'};
    if (scenario==='stop' && reads===2) await pending.promise;
    if (scenario==='duplicate' && attempts.length===2) return {result:'duplicate_suspected',accountIdentity};
    if (scenario==='late' && reads===2) return {result:'found_reviewing',accountIdentity,externalId:'late-old'};
    return {result:'absent_valid',accountIdentity,candidates:[],coverage:{complete:true,pagesVisited:5,
      statusesChecked:['draft','published','reviewing','scheduled','rejected'],windowStart:Date.parse(attempts[0].invoked_at),windowEnd:ms}};
  };
  const app=await setup(t,runtime,adapter,{clock:()=>new Date(ms).toISOString(),verifier});
  const a=(await app.request('accounts',{name:'重发测试',platform:'zhihu'})).body.id;
  await app.request('accounts/'+a+'/check',{});
  const payload={content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[a],requestKey:'same-intent',
    publicationPolicy:{verification:{enabled:true,firstCheckAfterSeconds:1,requiredValidChecks:1,
      absenceWindowSeconds:1,checkIntervalSeconds:1},retry:{maxResends:2,allowAbsentAfterTimeout:true,cooldownSeconds:[0,0]}}};
  assert.equal((await app.request('dispatch',payload)).status,201);
  const job=async()=>(await app.state()).jobs[0];
  await waitFor(async()=>(await job()).state==='unknown');
  await app.restart();
  ms+=2000;
  if(scenario==='stop') {
    await waitFor(()=>reads===2);
    const j=await job();
    assert.equal((await app.request('publications/'+j.id+'/stop',{expectedVersion:j.publicationIntent.version})).status,200);
    pending.resolve();
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await job()).publicationIntent.status,'stopped');
    assert.equal(clicks,1);
  } else if(scenario==='duplicate') {
    await waitFor(()=>clicks===2);
    ms+=2000;
    await waitFor(async()=>(await job()).publicationIntent.status==='duplicate_suspected');
    assert.equal((await job()).publicationIntent.next_check_at,null);
  } else if(scenario==='late') {
    await waitFor(async()=>(await job()).publicationIntent.status==='found_reviewing');
    assert.equal(clicks,1);
  } else {
    for (const n of [2,3]) {
      await waitFor(async()=>(await job()).usedAttempts===n && clicks===n);
      ms+=2000;
    }
    await waitFor(async()=>(await job()).publicationIntent.status==='limit_exhausted');
    assert.equal(clicks,3);
    assert.equal(await page.locator('body').getAttribute('data-count'),'3');
    assert.deepEqual(app.studio.db.prepare('SELECT ordinal FROM publication_attempts ORDER BY ordinal').all().map(r=>r.ordinal),[1,2,3]);
  }
});

for (const scenario of ['revalidate','takeover','bad_token','budget','cost']) test('准备阶段模型恢复：'+scenario,async t=>{
  let prepares=0,clicks=0,actions=0,asked=0;
  const pending=Promise.withResolvers();
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({}),close:async()=>{},reveal:async()=>{},
    observeRecovery:async()=>({observation:{token:'node',actions:['revalidate','dismiss_tip','human']},perform:async()=>{actions++;return true;}})};
  const adapter={prepare:async()=>{if (++prepares===1) throw Error('locator missing');return {};},
    submit:async(a,c,gate)=>{await gate();clicks++;return {id:'fixture'};}};
  const model=async()=>{asked++;await pending.promise;return {token:scenario==='bad_token'?'expired':'node',action:['budget','cost'].includes(scenario)?'dismiss_tip':'revalidate'};};
  const app=await setup(t,runtime,adapter,{model,recoveryLimits:scenario==='cost'?{maxCalls:4,maxMicros:1,callMicros:1}:{maxCalls:1}});
  const account=(await app.request('accounts',{name:'恢复测试',platform:'zhihu'})).body.id;
  await app.request('accounts/'+account+'/check',{});
  const c={...content,publication:{mode:'auto',aiAssisted:true}};
  await app.request('dispatch',{content:c,requestKey:'recovery-origin',accountIds:[account]});
  await waitFor(()=>asked);
  await app.request('dispatch',{content:c,requestKey:'other-account',accountIds:['demo-zhihu']});
  await waitFor(async()=>(await app.state()).jobs.some(j=>j.state==='demo_submitted'));
  const job=async()=>(await app.state()).jobs.find(j=>j.account_id===account);
  if(scenario==='takeover') assert.equal((await app.request('jobs/'+(await job()).id+'/inspect',{})).status,200);
  pending.resolve();
  await waitFor(async()=>(await job()).state===(scenario==='revalidate'?'submitted':scenario==='takeover'?'waiting_human':'needs_manual'));
  assert.equal(clicks,scenario==='revalidate'?1:0);
  assert.equal(actions,['budget','cost','revalidate'].includes(scenario)?1:0);
  assert.equal((await job()).publicationIntent.recovery.calls,1);
  if(scenario==='cost') assert.equal((await job()).publicationIntent.recovery.reason,'cost_limit');
});

test('准备前本人验证保留原任务，完成后重新核验',async t=>{
  let checked=0,prepares=0,clicks=0,calls=0,reveals=0;
  const runtime={check:async()=>{checked++;return {platformId:'owner'};},open:async()=>({}),close:async()=>{},
    reveal:async()=>{reveals++;},observeRecovery:async()=>({human:true})};
  const adapter={prepare:async()=>{if (++prepares===1) throw Error('page blocked');return {};},submit:async(a,c,gate)=>{await gate();clicks++;return {};}};
  const app=await setup(t,runtime,adapter,{model:async()=>{calls++;}});
  const account=(await app.request('accounts',{name:'本人验证',platform:'zhihu'})).body.id;
  await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},requestKey:'human-first',accountIds:[account]});
  const j=await waitFor(async()=>(await app.state()).jobs.find(j=>j.state==='waiting_human'));
  assert.equal(j.usedAttempts,0);assert.equal(reveals,1);assert.equal(calls,0);
  const prior=checked;
  assert.equal((await app.request('jobs/'+j.id+'/human-completed',{})).status,200);
  await waitFor(()=>clicks===1);
  assert.ok(checked>prior);
});

test('受控 Chromium：原页提示阻断准备，恢复后标准复核、门禁提交并查稿',async t=>{
  const {chromium}=await import('playwright');
  const {observeRecovery}=await import('../workflow/recovery-page.mjs');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<dialog open>使用提示</dialog><textarea></textarea><button onclick="document.body.dataset.submits=Number(document.body.dataset.submits||0)+1">提交</button>'}));
  await page.goto('https://zhuanlan.zhihu.com/write');
  const runtime={check:async()=>({platformId:'owner'}),open:async()=>({page}),close:async()=>{},
    observeRecovery:()=>observeRecovery(page,['zhuanlan.zhihu.com'])};
  const adapter={prepare:async(a,c)=>{
    if(await page.locator('dialog').isVisible()) throw Error('editor blocked');
    await page.locator('textarea').fill(c.title);
  },submit:async(a,c,gate)=>{
    assert.equal(await page.locator('textarea').inputValue(),c.title);
    await gate();await page.getByRole('button',{name:'提交'}).click();return {id:'fixture'};
  }};
  const actions=[];
  const app=await setup(t,runtime,adapter,{model:async observation=>{
    const action=observation.actions.includes('dismiss_tip')?'dismiss_tip':'revalidate';
    actions.push(action);return {action,token:observation.token};
  },verifier:async()=>({result:'found_reviewing',externalId:'fixture',accountIdentity:{verified:true,observed:'owner'}})});
  const account=(await app.request('accounts',{name:'恢复与查稿',platform:'zhihu'})).body.id;
  await app.request('accounts/'+account+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[account],requestKey:'end-to-end',
    publicationPolicy:{verification:{enabled:true,firstCheckAfterSeconds:0}}});
  const j=await waitFor(async()=>(await app.state()).jobs.find(j=>j.publicationIntent.status==='found_reviewing'));
  assert.deepEqual(actions,['dismiss_tip','revalidate']);
  assert.equal(await page.locator('body').getAttribute('data-submits'),'1');assert.equal(j.usedAttempts,1);
});

test('工作台保存恢复与重发参数，并从详情停止核对',async t=>{
  const app=await setup(t);
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const p=await browser.newPage();p.setDefaultTimeout(5000);
  await app.request('drafts',{content:{...content,publication:{mode:'auto',aiAssisted:true,silent:true}}});
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#compose');
  await p.locator('#open-drafts').click();await p.locator('[data-draft]').click();
  await p.locator('#recover-prepare').uncheck();
  await p.locator('#creator-check').check();
  await p.locator('#retry-limit').fill('2');await p.locator('#retry-delays').fill('30,90');
  await p.locator('[data-verification="checkIntervalSeconds"]').fill('45');
  await p.locator('#dispatch').click();
  const job=await waitFor(async()=>(await app.state()).jobs.find(j=>j.state==='demo_submitted'));
  const policy=job.publicationIntent.policy;
  assert.equal(policy.recovery.enabled,false);assert.equal(policy.verification.checkIntervalSeconds,45);
  assert.equal(policy.retry.maxResends,2);assert.deepEqual(policy.retry.cooldownSeconds,[30,90]);
  await p.locator('[data-job="'+job.id+'"]').click();
  await p.locator('#stop-check').click();
  await waitFor(async()=>(await app.state()).jobs.find(j=>j.id===job.id)?.publicationIntent.status==='stopped');
});

for (const scenario of ['read_again','human','stop','final_read_error','resend_prepare']) test('核对与重发准备恢复：'+scenario,async t=>{
  let reads=0,clicks=0,actions=0,modelCalls=0,prepares=0,reveals=0;
  const pending=Promise.withResolvers();
  const observation=()=>({observation:{actions:['revalidate','human'],token:'read'},perform:async()=>{actions++;return true;}});
  const source={observe:async()=>scenario==='human'?{human:true}:observation(),reveal:async()=>{reveals++;}};
  const runtime={check:async()=>({platformId:'owner'}),close:async()=>{},open:async()=>({}),observeRecovery:async()=>observation()};
  const adapter={prepare:async()=>{if (++prepares===2 && scenario==='resend_prepare') throw Error('tip');},
    submit:async(a,c,gate)=>{await gate();clicks++;throw Error('uncertain');}};
  let ms=Date.UTC(2026,1,1);
  const verifier=async({attempts})=>{
    reads++;
    if(reads===1 && !['final_read_error','resend_prepare'].includes(scenario)) throw Object.assign(Error('blank'),{recoveryPage:source});
    const accountIdentity={verified:true,observed:'owner'};
    if (reads===1 || (reads===2 && scenario==='resend_prepare'))
      return {result:'absent_valid',accountIdentity,candidates:[],coverage:{complete:true,pagesVisited:5,
        statusesChecked:['draft','published','reviewing','scheduled','rejected'],windowStart:Date.parse(attempts[0].invoked_at),windowEnd:ms}};
    if (reads===2 && scenario==='final_read_error') throw Error('read_failed');
    return {result:'found_reviewing',accountIdentity,externalId:'original'};
  };
  const model=async()=>{modelCalls++;if(scenario==='stop') await pending.promise;return {token:'read',action:'revalidate'};};
  const app=await setup(t,runtime,adapter,{model,verifier,clock:()=>new Date(ms).toISOString()});
  const a=(await app.request('accounts',{name:'查稿恢复',platform:'zhihu'})).body.id;await app.request('accounts/'+a+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[a],requestKey:'read-recovery',
    publicationPolicy:{verification:{enabled:true,firstCheckAfterSeconds:1,requiredValidChecks:1,absenceWindowSeconds:1,checkIntervalSeconds:1},
      retry:{maxResends:1,allowAbsentAfterTimeout:true,cooldownSeconds:[0]}}});
  const job=async()=>(await app.state()).jobs[0];
  await waitFor(async()=>(await job()).state==='unknown');ms+=2000;
  if (scenario==='stop') {
    await waitFor(()=>modelCalls===1);
    const j=await job();
    assert.equal((await app.request('publications/'+j.id+'/stop',{expectedVersion:j.publicationIntent.version})).status,200);
    pending.resolve();
    assert.equal((await job()).publicationIntent.status,'stopped');assert.equal(actions,0);
  } else if(scenario==='resend_prepare') {
    await waitFor(()=>clicks===2);assert.equal(prepares,3);assert.equal(actions,1);
    assert.equal((await job()).publicationIntent.recovery.stage,'resend_prepare');
  } else {
    if(scenario==='human') {
      const j=await waitFor(async()=>{const j=await job();return j.publicationIntent.status==='requires_human' && j;});
      assert.equal(reveals,1);assert.equal(modelCalls,0);
      assert.equal((await app.request('publications/'+j.id+'/human-completed',{expectedVersion:j.publicationIntent.version-1})).status,409);
      assert.equal((await app.request('publications/'+j.id+'/human-completed',{expectedVersion:j.publicationIntent.version})).status,200);
    }
    if(scenario==='final_read_error') {await waitFor(async()=>(await job()).publicationIntent.status==='inconclusive');ms+=2000;}
    await waitFor(async()=>(await job()).publicationIntent.status==='found_reviewing');
    assert.equal(actions,scenario==='read_again'?1:0);
  }
  assert.equal(clicks,scenario==='resend_prepare'?2:1);
});

const macroSpec = {topic:'测试主题',style:'专业简洁',facts:'本地测试资料',mode:'auto',assetIds:[],
  targets:[{accountId:'demo-zhihu',type:'article'},{accountId:'demo-bilibili',type:'article'}]};

test('宏观任务分账号成品、请求幂等、AI 声明、调用前预算',async t=>{
  let writes=0;
  const app=await setup(t,undefined,undefined,{writer:async({target})=>({title:'稿件 '+target.accountId,body:'稿件正文 '+(++writes),assetIds:[]})});
  const make=await app.request('task-templates',{spec:macroSpec,enabled:true});assert.equal(make.status,201);
  const path='task-templates/'+make.body.id+'/run';
  const run=await app.request(path,{requestKey:'one'});assert.equal(run.status,201);
  assert.equal((await app.request(path,{requestKey:'one'})).body.id,run.body.id);
  const details=async()=>(await app.request('runs/'+run.body.id)).body;
  await waitFor(async()=>(await details()).targets.every(t=>t.state==='dispatched'));
  assert.equal(writes,2);assert.equal((await details()).calls,2);
  const jobs=(await app.state()).jobs;
  assert.equal(jobs.length,2);
  for(const j of jobs) {assert.equal(j.content.title,'稿件 '+j.account_id);assert.equal(j.content.publication.aiAssisted,true);}
  const changed={spec:{...macroSpec,maxCalls:1,topic:'改版'},enabled:true,expectedVersion:1};
  assert.equal((await app.request('task-templates/'+make.body.id,changed)).status,200);
  assert.equal((await app.request('task-templates/'+make.body.id,changed)).status,409);
  assert.equal((await details()).snapshot.topic,'测试主题');
  const next=(await app.request(path,{requestKey:'two'})).body;
  await waitFor(async()=>(await app.request('runs/'+next.id)).body.targets.some(t=>t.reason==='budget_exhausted'));
  assert.equal(writes,3);
});

test('提前生成，重启后准点分发；错过多期只领取最近一期',async t=>{
  let ms=Date.UTC(2026,0,1),writes=0;
  const app=await setup(t,undefined,undefined,{clock:()=>new Date(ms).toISOString(),writer:async()=>({title:'定期稿',body:'正文 '+(++writes),assetIds:[]})});
  const first=ms+60000;
  const spec={...macroSpec,targets:macroSpec.targets.slice(0,1),schedule:{startAt:new Date(first).toISOString(),intervalSeconds:3600,prepareLeadSeconds:60}};
  const template=(await app.request('task-templates',{spec,enabled:true})).body;
  const runs=async()=>(await app.request('runs')).body;
  await waitFor(()=>writes===1);
  const run=(await runs())[0];
  await waitFor(async()=>(await app.request('runs/'+run.id)).body.targets[0].state==='ready');
  assert.equal((await app.state()).jobs.length,0);
  await app.restart();ms=first;
  await waitFor(async()=>(await app.state()).jobs.length===1);
  assert.equal(writes,1);
  await app.request('task-templates/'+template.id,{expectedVersion:1,enabled:true,spec:{...spec,topic:'未来一期'}});
  ms+=3*3600000;
  await waitFor(async()=>(await runs()).length===2);
  const newest=(await runs())[0];
  assert.equal(newest.scheduled_for,new Date(ms).toISOString());assert.equal((await app.request('runs/'+newest.id)).body.snapshot.topic,'未来一期');
});

test('宏观运行停止使迟到的模型结果失效；缺少模型明确阻断',async t=>{
  const pending=Promise.withResolvers();let called=false;
  const app=await setup(t,undefined,undefined,{writer:async()=>{called=true;return await pending.promise;}});
  const template=(await app.request('task-templates',{spec:macroSpec,enabled:true})).body;
  const run=(await app.request('task-templates/'+template.id+'/run',{requestKey:'stop'})).body;
  await waitFor(()=>called);
  assert.equal((await app.request('runs/'+run.id+'/stop',{})).status,200);
  pending.resolve({title:'迟到稿',body:'正文',assetIds:[]});
  await new Promise(r=>setTimeout(r,50));
  assert.ok((await app.request('runs/'+run.id)).body.targets.every(t=>t.state==='cancelled'&&!t.artifact));
  assert.equal((await app.state()).jobs.length,0);
  const missing=await setup(t,undefined,undefined,{writer:null});
  const mt=(await missing.request('task-templates',{spec:macroSpec,enabled:true})).body;
  const mr=(await missing.request('task-templates/'+mt.id+'/run',{requestKey:'missing'})).body;
  await waitFor(async()=>(await missing.request('runs/'+mr.id)).body.targets.every(t=>t.reason==='missing_model'));
});

test('宏观任务同平台多账号图文独立选材，越界素材仅阻断对应目标',async t=>{
  const accountIds=['xhs-fixture-1','xhs-fixture-2','xhs-fixture-3'];
  const app=await setup(t,undefined,undefined,{writer:async({target,assets})=>{
    assert.ok(assets.every(a=>a.description.startsWith('测试图片')));
    const index=accountIds.indexOf(target.accountId);
    return {title:'图文 '+index,body:'正文',assetIds:[assets[index]?.id??'outside-allowed-assets']};
  }});
  for(const id of accountIds)app.studio.db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created) VALUES(?,?,?,?,?,?)')
    .run(id,'xhs',id,'demo','demo',new Date().toISOString());
  const ids=[(await app.upload()).id,(await app.upload()).id];
  const spec={...macroSpec,targets:accountIds.map(accountId=>({accountId,type:'note'})),assetIds:ids,
    assetNotes:Object.fromEntries(ids.map((id,i)=>[id,'测试图片'+i]))};
  const template=(await app.request('task-templates',{spec,enabled:true})).body;
  const run=(await app.request('task-templates/'+template.id+'/run',{requestKey:'images'})).body;
  const targets=await waitFor(async()=>{
    const rows=(await app.request('runs/'+run.id)).body.targets;
    return rows.every(t=>['blocked','dispatched'].includes(t.state))&&rows;
  });
  assert.deepEqual(targets.slice(0,2).map(t=>t.artifact.assetIds),ids.map(id=>[id]));
  assert.equal(targets[2].reason,'invalid_artifact');assert.equal((await app.state()).jobs.length,2);
});

test('工作台创建宏观模板、立即运行并打开各账号成品',async t=>{
  const app=await setup(t,undefined,undefined,{writer:async()=>({title:'宏观界面稿',body:'生成正文',assetIds:[]})});
  const {chromium}=await import('playwright');const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());const p=await browser.newPage();p.setDefaultTimeout(5000);
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#macros');
  const f=p.locator('#macro-form');
  await f.locator('[name=topic]').fill('界面模板');await f.locator('[name=style]').fill('实验室视角');await f.locator('[name=facts]').fill('项目在本地运行');
  await f.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();await f.locator('[name=reviewBeforePublish]').uncheck();await f.getByRole('button',{name:'保存任务'}).click();
  await p.locator('[data-macro-run]').click();
  await waitFor(async()=>(await app.state()).jobs.length===1);
  await p.locator('[data-macro-details]').click();
  await p.locator('#detail-content').getByText('宏观界面稿',{exact:true}).waitFor();
});

test('宏观生成费用先预留，跨账号冷却隔离，同账号后续运行排除已用素材',async t=>{
  const app=await setup(t,undefined,undefined,{writerCallMicros:10,writer:async({assets})=>({title:'图片',body:'图文',assetIds:assets.slice(0,1).map(a=>a.id)})});
  const ids=['xhs-budget-1','xhs-budget-2'];
  for(const id of ids)app.studio.db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created) VALUES(?,?,?,?,?,?)')
    .run(id,'xhs',id,'demo','demo',new Date().toISOString());
  const img=(await app.upload()).id;
  const spec={...macroSpec,assetIds:[img],assetCooldownSeconds:3600,maxMicros:10,targets:ids.map(accountId=>({accountId,type:'note'}))};
  const t1=(await app.request('task-templates',{enabled:true,spec})).body;
  async function settled(key) {
    const r=(await app.request('task-templates/'+t1.id+'/run',{requestKey:key})).body;
    return waitFor(async()=>{const d=(await app.request('runs/'+r.id)).body;return d.targets.every(t=>['dispatched','blocked'].includes(t.state))&&d;});
  }
  const first=await settled('first');
  assert.equal(first.reserved_micros,10);assert.equal(first.targets[1].reason,'cost_limit');
  const second=await settled('second');
  assert.equal(second.targets[0].reason,'insufficient_assets');assert.equal(second.targets[1].state,'dispatched');
});

test('图片 OCR 保存在本机，显式授权后才供模型使用；快照与校正版隔离',async t=>{
  let scans=0;const seen=[];
  const app=await setup(t,undefined,undefined,{recognize:async()=>{scans++;return {text:'原图文字',language:'zh-CN',width:100,height:80};},
    writer:async({assets})=>{seen.push(assets[0]);return {title:'读图',body:'正文',assetIds:[]};}});
  const id=(await app.upload()).id,base='assets/'+id;
  const create=async(enabled)=>{
    const spec={...macroSpec,targets:macroSpec.targets.slice(0,1),assetIds:[id],useImageText:enabled};
    return (await app.request('task-templates',{enabled:true,spec})).body.id;
  };
  const disabled=await create(false),enabled=await create(true);
  async function run(template,key){
    const r=await app.request('task-templates/'+template+'/run',{requestKey:key});
    await waitFor(async()=>(await app.request('runs/'+r.body.id)).body.targets[0].state==='dispatched');
  }
  await run(disabled,'off');
  assert.equal(scans,0);assert.equal('imageText' in seen[0],false);
  await run(enabled,'on');assert.equal(scans,1);assert.equal(seen[1].imageText,'原图文字');
  const ocr=(await app.request(base+'/text')).body;
  assert.equal(ocr.source,'windows_ocr');assert.equal(ocr.version,1);
  const r=await app.request('task-templates/'+enabled+'/run',{requestKey:'snapshot'});
  const updated=await app.request(base+'/text',{expectedVersion:1,text:'人工校正'});
  assert.equal(updated.body.version,2);
  assert.equal((await app.request(base+'/text',{expectedVersion:1,text:'旧操作'})).status,409);
  await waitFor(async()=>(await app.request('runs/'+r.body.id)).body.targets[0].state==='dispatched');
  assert.equal(seen[2].imageText,'原图文字');
  await app.restart();await run(enabled,'next');assert.equal(scans,1);assert.equal(seen[3].imageText,'人工校正');
});

test('OCR 失败保留生成预算，可手工补录后恢复同一个目标',async t=>{
  const app=await setup(t,undefined,undefined,{recognize:async()=>{throw Error('fixture');},writer:async({assets})=>({title:'校正',body:assets[0].imageText,assetIds:[]})});
  const id=(await app.upload()).id;
  const spec={...macroSpec,targets:macroSpec.targets.slice(0,1),useImageText:true,assetIds:[id]};
  const tmpl=(await app.request('task-templates',{enabled:true,spec})).body.id;
  const run=(await app.request('task-templates/'+tmpl+'/run',{requestKey:'failed-ocr'})).body;
  const path='runs/'+run.id;
  const blocked=await waitFor(async()=>{const d=(await app.request(path)).body;return d.targets[0].reason==='image_text_failed' && d;});
  assert.equal(blocked.calls,0);
  await app.request('assets/'+id+'/text',{expectedVersion:0,text:'手工标注'});
  assert.equal((await app.request(path+'/targets/'+blocked.targets[0].id+'/resume',{})).status,200);
  await waitFor(async()=>(await app.state()).jobs.some(j=>j.content.body==='手工标注'));
});

test('首图失败后重启，使用已存文案渲染真实 PNG，不重复调用模型',async t=>{
  const {renderNoteCard}=await import('../workflow/note-card.mjs');
  let renders=0,writes=0;
  const app=await setup(t,undefined,undefined,{writer:async({assets})=>{
    writes++;return {title:'本周进度',body:'测试正文',assetIds:[assets[0].id]};},
    renderCard:async context=>{if(++renders===1)throw Error('fixture_failure');return renderNoteCard(context);}});
  app.studio.db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created) VALUES(?,?,?,?,?,?)')
    .run('fixture-card','xhs','图片模板','demo','demo',new Date().toISOString());
  const asset=(await app.upload()).id;
  const spec={...macroSpec,noteCard:true,assetIds:[asset],targets:[{accountId:'fixture-card',type:'note'}]};
  const template=(await app.request('task-templates',{enabled:true,spec})).body.id;
  const run=(await app.request('task-templates/'+template+'/run',{requestKey:'card'})).body.id;
  const details=async()=>(await app.request('runs/'+run)).body;
  await waitFor(async()=>(await details()).targets[0].reason==='card_render_failed');
  await app.restart();
  const target=(await details()).targets[0].id;
  assert.equal((await app.request('runs/'+run+'/targets/'+target+'/resume',{})).status,200);
  const job=await waitFor(async()=>(await app.state()).jobs[0],2000);
  assert.equal(writes,1);assert.equal(renders,2);assert.equal((await details()).calls,1);
  const card=job.content.generatedCoverId;assert.deepEqual(job.content.assetIds,[card,asset]);
  const png=Buffer.from(await (await fetch('http://127.0.0.1:'+app.studio.server.address().port+'/media/'+card)).arrayBuffer());
  assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1080);assert.equal(png.readUInt32BE(20),1440);
});

test('启动按平台加载核对配置，知乎重启后根据真实格式回执 ID 查稿',async t=>{
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage();
  await context.route('https://www.zhihu.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',
    body:'<main id="ready">列表</main><article><a href="https://zhuanlan.zhihu.com/p/7788">稿件</a><h2>后来修改的标题</h2><em>已发布</em><i>文章</i></article>'}));
  let ms=Date.UTC(2026,0,1);
  const app=await setup(t,{open:async()=>({context,page}),check:async()=>({platformId:'fixture'}),close:async()=>{}},
    {prepare:async()=>({}),submit:async(a,c,gate)=>{await gate();return {simulated:false,id:'7788',url:'https://zhuanlan.zhihu.com/p/7788'};}},
    {clock:()=>new Date(ms).toISOString()});
  const id=(await app.request('accounts',{name:'受控知乎',platform:'zhihu'})).body.id;
  await app.request('accounts/'+id+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},requestKey:'receipt-id',accountIds:[id],
    publicationPolicy:{verification:{enabled:true,firstCheckAfterSeconds:60}}});
  await waitFor(async()=>(await app.state()).jobs[0]?.state==='submitted');
  writeFileSync(join(app.dir,'zhihu-verifier.json'),JSON.stringify({url:'https://www.zhihu.com/creator/fixture',complete:'#ready',row:'article',title:'h2',body:'p',type:'i',time:'time',status:'em',link:'a',types:{article:'文章'}}));
  writeFileSync(join(app.dir,'douyin-verifier.json'),'{"url":"https://example.test"}');
  await app.restart();
  const states=(await app.state()).capabilities.creatorReaders;
  assert.equal(states.zhihu,'configured');assert.equal(states.douyin,'invalid_config');assert.equal(states.bilibili,'unconfigured');
  ms+=61000;
  const job=await waitFor(async()=>{const j=(await app.state()).jobs[0];return j.publicationIntent.status==='found_published'&&j;});
  assert.equal(job.publicationIntent.lastObservation.external_id,'7788');assert.equal(job.usedAttempts,1);
  assert.equal(page.url(),'about:blank');
});

test('查稿记录按任务分页，覆盖范围可读且不返回账号身份值',async t=>{
  const app=await setup(t);
  await app.request('dispatch',{requestKey:'observations-api',content,accountIds:['demo-zhihu','demo-bilibili']});
  const [first,other]=(await app.state()).jobs;
  const statement=app.studio.db.prepare('INSERT INTO verification_observations(job_id,checked_at,result,evidence) VALUES(?,?,?,?)');
  const proof=JSON.stringify({ordinal:1,accountIdentity:{expected:'private-identity',observed:'private-identity',verified:true},
    coverage:{complete:true,pagesVisited:6,statusesChecked:['published','reviewing','scheduled','draft','rejected'],windowStart:1000,windowEnd:2000}});
  for(let i=0;i<26;i++)statement.run(first.id,new Date().toISOString(),'absent_valid',proof);
  statement.run(other.id,new Date().toISOString(),'inconclusive',null);
  const endpoint='publications/'+first.id+'/observations';
  const a=(await app.request(endpoint)).body;
  assert.equal(a.entries.length,25);assert.equal(a.entries[0].coverage.pagesVisited,6);
  assert.equal(JSON.stringify(a).includes('private-identity'),false);
  const b=(await app.request(endpoint+'?before='+a.nextBefore)).body;
  assert.equal(b.entries.length,1);assert.equal(b.nextBefore,null);assert.ok(b.entries[0].id<a.nextBefore);
  assert.equal((await app.request(endpoint+'?before=invalid')).status,400);
});

test('素材库识别与人工校正按钮保存版本，模板勾选图片文字和首图',async t=>{
  const app=await setup(t,undefined,undefined,{recognize:async()=>({text:'图片初稿',language:'zh',width:512,height:256})});
  const img=(await app.upload()).id;
  const {chromium}=await import('playwright');const b=await chromium.launch({channel:'chrome',headless:true});t.after(()=>b.close());
  const p=await b.newPage();p.setDefaultTimeout(5000);
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#assets');
  await p.locator('[data-edit-asset="'+img+'"]').click();
  await p.getByRole('button',{name:'识别或校正图片文字'}).click();
  await p.locator('#read-image-text').click();
  await p.waitForFunction(()=>document.querySelector('#image-text')?.value==='图片初稿');
  await p.locator('#image-text').fill('人工校正内容');await p.locator('#save-image-text').click();
  await p.locator('#detail').waitFor({state:'hidden'});
  const saved=(await app.request('assets/'+img+'/text')).body;assert.equal(saved.version,2);assert.equal(saved.text,'人工校正内容');
  await p.locator('[data-nav=macros]').click();const f=p.locator('#macro-form');
  await f.locator('[name=topic]').fill('识别与制图');await f.locator('[name=facts]').fill('图片说明');await f.locator('[name=style]').fill('简洁');
  await f.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();await f.locator('[name=asset]').check();
  await f.locator('[name=useImageText]').check();await f.locator('[name=noteCard]').check();
  await f.locator('[name=reviewBeforePublish]').uncheck();await f.getByRole('button',{name:'保存任务'}).click();await p.locator('[data-macro-edit]').waitFor();
  const spec=(await app.request('task-templates')).body[0].spec;
  assert.ok(spec.noteCard&&spec.useImageText);assert.deepEqual(spec.assetIds,[img]);
});

test('外部视频模型持久化任务，重启只轮询；成片使用授权测试 MP4',async t=>{
  const {readFileSync,existsSync}=await import('node:fs');
  let ms=Date.UTC(2026,1,1),creates=0,checks=0;
  const source=process.env.MATRIX_TEST_VIDEO||'E:/矩阵调研2/抖音测试视频/Dota 2 2026-04-09 11-20-13.mp4';
  if(!existsSync(source)){t.skip('本机未提供授权视频样例');return;}
  const bytes=readFileSync(source);
  assert.ok(bytes.length<20*1024*1024);
  const app=await setup(t,undefined,undefined,{clock:()=>new Date(ms).toISOString(),
    writer:async()=>({title:'模型视频',body:'视频说明',scenes:[{text:'根据项目事实介绍本周进度。'}]}),
    videoCallMicros:5,videoBudgetMicros:5,
    videoProvider:{create:async()=>{creates++;return {id:'remote-1'};},check:async id=>{assert.equal(id,'remote-1');return {status:++checks===1?'running':'succeeded',video_url:'https://fixture.invalid/video'};},
      download:async()=>bytes}});
  const spec={...macroSpec,targets:[{accountId:'demo-bilibili',type:'video'}]};
  const template=(await app.request('task-templates',{spec,enabled:true})).body.id;
  const run=(await app.request('task-templates/'+template+'/run',{requestKey:'external-video'})).body.id;
  await waitFor(()=>checks===1);await app.restart();ms+=31000;
  const job=await waitFor(async()=>(await app.state()).jobs[0],1000);
  assert.equal(creates,1);assert.equal(checks,2);assert.equal(job.content.type,'video');assert.equal(job.content.assetIds.length,1);
  assert.ok(job.content.generatedVideoId);assert.equal((await app.request('runs/'+run)).body.calls,1);
  const tasks=app.studio.db.prepare('SELECT remote_id,status,reserved_micros FROM video_model_tasks').all();
  assert.equal(tasks[0].status,'complete');assert.equal(tasks[0].reserved_micros,5);
});

test('视频付费请求响应丢失后重启，不自动再次创建',async t=>{
  let creates=0;
  const app=await setup(t,undefined,undefined,{writer:async()=>({title:'未知视频任务',body:'描述',scenes:[{text:'一个场景'}]}),
    videoCallMicros:1,videoBudgetMicros:1,videoProvider:{create:async()=>{creates++;throw Error('network_timeout');}}});
  const template=(await app.request('task-templates',{enabled:true,spec:{...macroSpec,targets:[{accountId:'demo-bilibili',type:'video'}]}})).body.id;
  const r=(await app.request('task-templates/'+template+'/run',{requestKey:'unknown-video'})).body.id;
  const path='runs/'+r;
  const blocked=await waitFor(async()=>{const d=(await app.request(path)).body;return d.targets[0].reason==='video_creation_unknown'&&d;});
  assert.equal(blocked.videoTasks[0].reserved_micros,1);
  await app.restart();
  assert.equal((await app.request(path+'/targets/'+blocked.targets[0].id+'/resume',{})).status,409);
  assert.equal(creates,1);assert.equal((await app.state()).jobs.length,0);
});

test('Agent 工具目录与业务服务共用幂等模板、运行、发布版本及门禁',async t=>{
  let prepares=0;
  const app=await setup(t,{check:async()=>({platformId:'agent'}),open:async()=>({}),close:async()=>{}},
    {prepare:async()=>{prepares++;throw Error('fixture');}},{writer:async()=>({title:'Agent稿',body:'正文',assetIds:[]})});
  const catalog=(await app.request('agent/tools')).body;
  assert.ok(['save_template','run_template','publication','verify','recover','request-retry','human-completed','stop'].every(name=>catalog.some(t=>t.name===name)));
  const call=(name,args)=>app.request('agent/actions',{name,arguments:args});
  assert.equal((await call('arbitrary-browser-eval',{})).status,422);
  assert.equal((await call('verify',{id:'x',expectedVersion:1,absence:true})).status,422);
  const template=(await call('save_template',{enabled:true,spec:macroSpec})).body.result;
  const run=(await call('run_template',{id:template.id,requestKey:'agent-intent'})).body.result;
  assert.equal((await call('run_template',{id:template.id,requestKey:'agent-intent'})).body.result.id,run.id);
  await waitFor(async()=>{const jobs=(await app.state()).jobs;return jobs.length===2&&jobs.every(j=>j.state==='demo_submitted');});
  const job=(await app.state()).jobs[0],intent=(await call('publication',{id:job.id})).body.result;
  assert.equal((await call('stop',{id:job.id,expectedVersion:intent.version+1})).body.reasonCode,'version_conflict');
  assert.equal((await call('stop',{id:job.id,expectedVersion:intent.version})).body.result.reasonCode,'stopped');
  assert.equal(app.studio.agentTools.execute('publication',{id:job.id}).status,'stopped');
  const a=(await app.request('accounts',{name:'待恢复',platform:'zhihu'})).body.id;await app.request('accounts/'+a+'/check',{});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:[a],requestKey:'recover-api'});
  const failed=await waitFor(async()=>(await app.state()).jobs.find(j=>j.account_id===a && j.state==='needs_manual'));
  const result=await app.request('publications/'+failed.id+'/recover',{expectedVersion:failed.publicationIntent.version});
  assert.equal(result.body.reasonCode,'missing_model');assert.equal(prepares,1);
});

test('主动查稿节流和重发评估接口不接受调用方自证缺席',async t=>{
  let ms=Date.UTC(2026,1,1),checks=0;
  const app=await setup(t,undefined,undefined,{clock:()=>new Date(ms).toISOString(),
    verifier:async()=>{checks++;return {result:'inconclusive'};}});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:['demo-zhihu'],requestKey:'manual-check'});
  const j=await waitFor(async()=>(await app.state()).jobs.find(j=>j.state==='demo_submitted'));
  const path='publications/'+j.id;
  assert.equal((await app.request(path+'/request-retry',{expectedVersion:j.publicationIntent.version})).body.reasonCode,'retry_disabled');
  assert.equal((await app.request(path+'/verify',{expectedVersion:j.publicationIntent.version,observedAccountId:'x'})).status,422);
  assert.equal((await app.request(path+'/verify',{expectedVersion:j.publicationIntent.version})).body.reasonCode,'verification_scheduled');
  await waitFor(()=>checks===1);
  const now=await waitFor(async()=>{const x=(await app.request(path)).body;return x.lastObservation&&x;});
  assert.equal(now.next_check_at,null);
  const queued=await app.request(path+'/verify',{expectedVersion:now.version});
  assert.ok(queued.body.next_check_at>new Date(ms).toISOString());assert.equal(checks,1);
});

test('工作台发布详情主动查稿按钮调用统一动作服务',async t=>{
  let checks=0;
  const app=await setup(t,undefined,undefined,{verifier:async()=>{checks++;return {result:'inconclusive'};}});
  await app.request('dispatch',{content:{...content,publication:{mode:'auto',aiAssisted:true}},accountIds:['demo-zhihu'],requestKey:'ui-verify-service'});
  const j=await waitFor(async()=>(await app.state()).jobs.find(j=>j.state==='demo_submitted'));
  const {chromium}=await import('playwright');const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const p=await browser.newPage();p.setDefaultTimeout(5000);
  await p.goto('http://127.0.0.1:'+app.studio.server.address().port+'/#tasks');
  await p.locator('[data-job="'+j.id+'"]').click();
  await p.getByRole('button',{name:'主动查稿',exact:true}).click();
  await waitFor(()=>checks===1);
  const latest=(await app.request('publications/'+j.id)).body;
  assert.equal(latest.attempts.length,1);assert.ok(latest.lastObservation);
});
