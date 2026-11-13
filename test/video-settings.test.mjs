import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {videoSettings} from '../workflow/video-settings.mjs';
import {videoJobs,configuredVideoProvider} from '../workflow/video-model.mjs';
import {createStudio} from '../server.mjs';
const official='https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
const profile={create:true,name:'万相3.0',provider:'wan3',model:'wan3.0-video',endpoint:official,key:'private-video-key',duration:5,resolution:'720P',audio:true};
const wait=async fn=>{for(let i=0;i<600;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('等待视频流程超时');};
async function setup(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'matrix-video-settings-'));let studio,base,token;
  const start=async()=>{studio=createStudio({dataDir:dir,tickMs:8,demoDelay:8,...options});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+studio.server.address().port;token=(await fetch(base+'/api/state').then(r=>r.json())).token;};await start();
  t.after(async()=>{await studio.close();const path=resolve(dir);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith('matrix-video-settings-'));rmSync(path,{recursive:true,force:true});});
  const api=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  return {api,get base(){return base;},get studio(){return studio;},get token(){return token;},restart:async()=>{await studio.close();await start();}};
}
function ledger(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT); CREATE TABLE workflow_targets(id TEXT PRIMARY KEY,run_id TEXT);');return db;}
const artifact={scenes:[{text:'一只小猫玩球'}],videoPrompt:'午后暖光，小猫在地毯上追逐红球，镜头平稳，轻快音乐。'};

test('视频配置多配置持久化、切换、密钥隔离及不发请求的配置检查',()=>{
  const db=new DatabaseSync(':memory:');try{
    let requests=0;const settings=videoSettings(db,{},async()=>{requests++;throw Error('不应发请求');});
    const first=settings.save(profile),id=first.savedId;assert.equal(first.activeId,id);assert.equal(first.configured,true);assert.equal(first.hasKey,true);assert.ok(!JSON.stringify(first).includes('private-video-key'));
    assert.equal(settings.check(id).ok,true);assert.equal(requests,0);
    const second=settings.save({...profile,activate:false,name:'未来网关',provider:'json',model:'future-video',endpoint:'http://127.0.0.1:1234/jobs',key:'gateway-private'}).savedId;
    assert.equal(settings.view().profiles.length,2);assert.equal(settings.view().activeId,id);settings.select(second);assert.equal(settings.view().model,'future-video');
    settings.save({...profile,create:false,id,activate:false,key:''});assert.equal(settings.view().profiles.find(p=>p.id===id).hasKey,true);
    settings.save({...profile,create:false,id,activate:false,endpoint:official.replace('workspace.','other.'),key:''});assert.equal(settings.view().profiles.find(p=>p.id===id).hasKey,false);assert.equal(settings.capture(id).provider,null);
    assert.equal(videoSettings(db,{}).view().activeId,second);assert.ok(!JSON.stringify(settings.view()).includes('gateway-private'));
    assert.throws(()=>settings.save({...profile,endpoint:'https://bad.example/create'}),/视频接口/);assert.throws(()=>settings.save({...profile,endpoint:official+'?key=secret'}),/视频接口/);assert.throws(()=>settings.save({...profile,callMicros:5,maxMicros:null}),/费用/);
  }finally{db.close();}
});

test('按持久 profile_id 轮询原任务：切换默认、重启及短暂查询失败不再次创建',async t=>{
  const db=ledger(t);let ms=Date.parse('2026-11-12T00:00:00Z'),creates=0,checks=0,active='a';db.exec("INSERT INTO workflow_targets VALUES('target','run')");
  const calls=[];const providers={a:{identity:'a',create:async prompt=>{creates++;assert.equal(prompt.prompt,artifact.videoPrompt);return {id:'remote-a'};},check:async()=>{checks++;if(checks===1)throw Error('transient');return {status:'succeeded',video_url:'https://result.example/a.mp4'};},download:async()=>Buffer.from('known-video')},b:{identity:'b',create:async()=>{throw Error('不能换模型生成');}}};
  const resolveProvider=id=>{id ||= active;calls.push(id);return {id,provider:providers[id],callMicros:0,maxMicros:null,maxGenerations:1,allowUnpriced:true};};
  const options={db,resolveProvider,clock:()=>new Date(ms).toISOString(),isClosed:()=>false};let generate=videoJobs(options);
  await assert.rejects(generate('target',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_pending');assert.equal(db.prepare('SELECT profile_id FROM video_model_tasks').get().profile_id,'a');
  active='b';ms+=31000;generate=videoJobs(options);assert.equal((await generate('target',artifact,'portrait',AbortSignal.timeout(2000))).video.toString(),'known-video');assert.equal(creates,1);assert.equal(checks,2);assert.deepEqual(calls,['a','a']);
});

test('视频次数预算、创建未知、配置变更和失效任务均不自动再创建',async t=>{
  const db=ledger(t);let creates=0,key='original',limit=1;db.exec("INSERT INTO workflow_targets VALUES('first','run'),('second','run'),('unknown','another')");
  const provider={get identity(){return key;},create:async(p,id)=>{creates++;if(id==='unknown')throw Error('lost-response');return {id:'r-'+id};},check:async()=>({status:'running'})};
  const generate=videoJobs({db,resolveProvider:()=>({id:'profile',provider,callMicros:0,maxMicros:null,allowUnpriced:true,maxGenerations:limit}),clock:()=>new Date().toISOString(),isClosed:()=>false});
  await assert.rejects(generate('first',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_pending');await assert.rejects(generate('second',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_call_limit');assert.equal(creates,1);
  key='changed';await assert.rejects(generate('first',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_provider_changed');assert.equal(creates,1);
  await assert.rejects(generate('unknown',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_creation_unknown');await assert.rejects(generate('unknown',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_creation_unknown');assert.equal(creates,2);
  limit=2;await assert.rejects(generate('second',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_pending');assert.equal(creates,3);
});

test('万相音频参数及下载隔离：结果下载不携带密钥，拒绝越权下载主机',async()=>{
  const requests=[];const request=async(url,options)=>{requests.push({url:String(url),options});if(options.method==='POST')return {ok:true,json:async()=>({output:{task_id:'wan'}})};return new Response(Buffer.from([0,0,0,12,...Buffer.from('ftypisom')]));};
  const p=configuredVideoProvider({MATRIX_VIDEO_ENDPOINT:official,MATRIX_VIDEO_KEY:'private-key',MATRIX_VIDEO_AUDIO:'0'},request);
  await p.create({prompt:'原提示词',aspect_ratio:'16:9'},'id',AbortSignal.timeout(2000));assert.equal(JSON.parse(requests[0].options.body).parameters.audio,false);
  await p.download('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.mp4',AbortSignal.timeout(2000));assert.equal(requests[1].options.headers,undefined);
  await p.download('https://dashscope-a717.oss-accelerate.aliyuncs.com/result.mp4',AbortSignal.timeout(2000));assert.equal(requests[2].options.headers,undefined);
  for(const host of ['attacker.example','dashscope-a717.oss-accelerate.aliyuncs.com.attacker.example','other-bucket.oss-accelerate.aliyuncs.com'])await assert.rejects(p.download('https://'+host+'/result.mp4',AbortSignal.timeout(2000)),e=>e.code==='video_download_host');assert.equal(requests.length,3);
});

test('下载域名失败保留原远程任务，恢复只查询及下载，不重新生成',async t=>{
  const db=ledger(t);db.exec("INSERT INTO workflow_targets VALUES('target','run')");let creates=0,downloads=0,allow=false;
  const provider={identity:'unchanged',create:async()=>{creates++;return {id:'original-remote'};},check:async()=>({status:'succeeded',video_url:'https://dashscope-a717.oss-accelerate.aliyuncs.com/clip.mp4'}),download:async()=>{downloads++;if(!allow)throw Object.assign(Error(),{code:'video_download_host'});return Buffer.from('original-result');}};
  const generate=videoJobs({db,provider,callMicros:1,maxMicros:10,clock:()=>new Date().toISOString(),isClosed:()=>false});
  await assert.rejects(generate('target',artifact,'portrait',AbortSignal.timeout(2000)),e=>e.code==='video_download_host');
  assert.equal(db.prepare('SELECT remote_id FROM video_model_tasks').get().remote_id,'original-remote');allow=true;
  assert.equal((await generate('target',artifact,'portrait',AbortSignal.timeout(2000))).video.toString(),'original-result');assert.equal(creates,1);assert.equal(downloads,2);
});

test('账号成品弹窗自动刷新状态，关闭/切换编辑后停止刷新且迟到响应不覆盖新内容',async t=>{
  const app=await setup(t,{writer:async()=>({title:'受控稿件',body:'受控正文',assetIds:[]})});
  const template=await app.api('task-templates',{enabled:true,spec:{topic:'进度测试',style:'简洁',facts:'受控事实',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'manual',maxCalls:1}});
  const run=await app.api('task-templates/'+template.id+'/run',{requestKey:'progress'});const detail=await app.api('runs/'+run.id);
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(7000);
  let stage='generating',requests=0;
  await page.route('**/api/runs/'+run.id,route=>{requests++;const result=structuredClone(detail);result.targets[0].state=stage;result.targets[0].reason=stage==='blocked'?'video_download_host':null;return route.fulfill({json:result});});
  await page.goto(app.base+'/#macros');await page.locator('[data-macro-details="'+run.id+'"]').click();await page.locator('[data-run-progress]').filter({hasText:'生成中'}).waitFor();
  stage='blocked';await page.locator('[data-run-progress]').filter({hasText:'视频下载域名未获准'}).waitFor();assert.ok(requests>=2);
  await page.locator('.close-dialog').click();const closedAt=requests;await page.waitForTimeout(2100);assert.equal(requests,closedAt);
  // Exercise a late response after this modal is replaced by an editing form.
  await page.evaluate(async()=>{
    const {watchRunProgress}=await import('/macro.js');const dialog=document.querySelector('#detail'),parent=document.querySelector('#detail-content');parent.innerHTML='<section id="test-progress"></section>';dialog.showModal();
    const root=document.querySelector('#test-progress');window.progressRendered=0;window.polls=0;
    watchRunProgress({dialog,root,initial:0,interval:20,read:()=>{window.polls++;return new Promise(r=>window.finishProgress=r);},render:()=>{window.progressRendered++;parent.textContent='不应覆盖';}});
  });await page.waitForFunction(()=>window.polls===1);await page.waitForTimeout(70);assert.equal(await page.evaluate(()=>window.polls),1);
  await page.evaluate(()=>{document.querySelector('#detail-content').innerHTML='<textarea id="unsaved-editor">未保存的修改</textarea>';window.finishProgress(1);});await page.waitForTimeout(100);
  assert.equal(await page.locator('#unsaved-editor').inputValue(),'未保存的修改');assert.equal(await page.evaluate(()=>window.progressRendered),0);
});

test('保存的视频网关经实际HTTP异步调用、重启下载检查归档并自动发布，只经门禁提交一次',async t=>{
  const path=process.env.MATRIX_TEST_VIDEO||'E:/矩阵调研2/抖音测试视频/Dota 2 2026-04-09 11-20-13.mp4';if(!existsSync(path)){t.skip('缺少用户授权MP4');return;}
  const bytes=readFileSync(path);let creates=0,checks=0,submits=0,posted,ms=Date.parse('2026-11-12T00:00:00Z');
  const gateway=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,req.url==='/clip.mp4'?undefined:'Bearer gateway-test-key');
    if(req.url==='/clip.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});res.end(bytes);return;}
    res.setHeader('Content-Type','application/json');if(req.method==='POST'){let text='';for await(const part of req)text+=part;posted=JSON.parse(text);creates++;res.end(JSON.stringify({id:'remote-saved'}));return;}
    checks++;res.end(JSON.stringify(checks===1?{status:'running'}:{status:'succeeded',video_url:'http://127.0.0.1:'+gateway.address().port+'/clip.mp4'}));
  });await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gateway.close(r)));
  const runtime={check:async()=>({platformId:'fixture-owner'}),open:async()=>({}),close:async()=>{}};
  const adapter={prepare:async(a,c)=>{assert.ok(c.generatedVideoId);assert.ok(c.coverAssetId);assert.equal(c.publication.aiAssisted,true);},submit:async(a,c,gate)=>{await gate();submits++;return {id:'fixture-published',evidence:'受控适配器提交回执'};}};
  const app=await setup(t,{browserRuntime:runtime,publishAdapter:adapter,clock:()=>new Date(ms).toISOString(),writer:async()=>({title:'模型生成的猫咪视频',body:'受控配文',scenes:artifact.scenes,videoPrompt:artifact.videoPrompt})});
  const config=await app.api('video-settings',{...profile,provider:'json',endpoint:'http://127.0.0.1:'+gateway.address().port+'/jobs',model:'future-video',key:'gateway-test-key'});
  const account=(await app.api('accounts',{name:'受控视频账号',platform:'bilibili'})).id;await app.api('accounts/'+account+'/check',{});
  const spec={topic:'小猫玩球',style:'电影质感',facts:'只表现小猫玩球',targets:[{accountId:account,type:'video'}],assetIds:[],taskMode:'generate',mode:'auto',maxCalls:1,videoModelId:config.savedId};
  const template=await app.api('task-templates',{enabled:true,spec}),run=await app.api('task-templates/'+template.id+'/run',{requestKey:'saved-profile-video'});await wait(()=>checks===1);
  const other=await app.api('video-settings',{...profile,name:'默认已换为其他模型'});assert.notEqual(other.savedId,config.savedId);await app.restart();ms+=31000;
  const result=await wait(async()=>{const state=await app.api('state');return state.jobs.find(j=>j.state==='submitted');});assert.equal(creates,1);assert.equal(checks,2);assert.equal(submits,1);assert.equal(result.usedAttempts,1);assert.equal(posted.prompt,artifact.videoPrompt);assert.equal(posted.model,'future-video');assert.equal(posted.duration,5);
  const details=await app.api('runs/'+run.id);assert.equal(details.videoTasks[0].profile_id,config.savedId);assert.equal(details.videoTasks[0].status,'complete');assert.equal(details.snapshot.videoModelId,config.savedId);assert.equal(details.targets[0].artifact.videoPrompt,artifact.videoPrompt);
  assert.ok((await app.api('state')).assets.some(a=>a.id===result.content.generatedVideoId&&a.mime==='video/mp4'));assert.ok(!JSON.stringify(await app.api('agent/actions',{name:'context',arguments:{}})).includes('gateway-test-key'));
});

test('工作台万相地址辅助、多配置选择、任务绑定、原素材模式及本地检查不产生付费请求',async t=>{
  const app=await setup(t);const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.base+'/#macros');const form=page.locator('#video-settings-form');await page.locator('#video-workspace').fill('my-workspace');await page.locator('#video-region').selectOption('cn-beijing');await page.locator('#video-build-endpoint').click();assert.equal(await form.locator('[name=endpoint]').inputValue(),official.replace('workspace.','my-workspace.'));
  await form.locator('[name=key]').fill('ui-video-private');await form.locator('[name=name]').fill('UI万相');await page.locator('#video-check').click();await page.locator('#video-config-status').filter({hasText:'本地配置检查通过'}).waitFor();
  const saved=(await app.api('video-settings')).activeId;assert.ok(!JSON.stringify(await app.api('state')).includes('ui-video-private'));assert.equal(await page.locator('#macro-form [name=videoModelId] option').count(),2);
  // Editing only the workspace must update the persisted endpoint without clicking the helper button.
  await page.locator('#video-workspace').fill('corrected-space');await page.locator('#video-region').selectOption('ap-southeast-1');
  const corrected=official.replace('workspace.cn-beijing','corrected-space.ap-southeast-1');assert.equal(await form.locator('[name=endpoint]').inputValue(),corrected);
  await form.getByRole('button',{name:'保存视频配置',exact:true}).click();await page.locator('#video-config-status').filter({hasText:'视频配置已保存'}).waitFor();
  assert.equal((await app.api('video-settings')).endpoint,corrected);assert.equal((await app.api('video-settings')).hasKey,false);
  await page.reload();await page.locator('#video-workspace').waitFor();assert.equal(await page.locator('#video-workspace').inputValue(),'corrected-space');assert.equal(await page.locator('#video-region').inputValue(),'ap-southeast-1');
  // A directly pasted endpoint takes precedence over the previous helper state.
  const pasted=official.replace('workspace.','pasted-space.');await form.locator('[name=endpoint]').fill(pasted);assert.equal(await page.locator('#video-workspace').inputValue(),'pasted-space');
  await form.locator('[name=key]').fill('replacement-private-key');await page.locator('#video-check').click();await page.locator('#video-config-status').filter({hasText:'本地配置检查通过'}).waitFor();
  assert.equal((await app.api('video-settings')).endpoint,pasted);assert.equal((await app.api('video-settings')).hasKey,true);
  // Invalid helper edits must never silently save the previous valid endpoint.
  await page.locator('#video-workspace').fill('bad workspace');await form.getByRole('button',{name:'保存视频配置',exact:true}).click();assert.equal((await app.api('video-settings')).endpoint,pasted);
  await page.locator('#video-workspace').fill('pasted-space');
  await page.locator('#video-new').click();await form.locator('[name=provider]').selectOption('json');await form.locator('[name=endpoint]').fill('http://127.0.0.1:1234/jobs');await form.locator('[name=model]').fill('future-video');await form.getByRole('button',{name:'保存视频配置',exact:true}).click();await page.locator('#video-config-status').filter({hasText:'视频配置已保存'}).waitFor();assert.equal((await app.api('video-settings')).profiles.length,2);
  const task=page.locator('#macro-form');await task.locator('[name=videoModelId]').selectOption(saved);await task.locator('[name=topic]').fill('猫咪视频');await task.locator('[name=style]').fill('平稳镜头');await task.locator('[name=facts]').fill('小猫追球');await task.locator('[name=target][value=demo-bilibili][data-macro-type=video]').check();await task.getByRole('button',{name:'保存任务',exact:true}).click();await page.locator('[data-macro-edit]').waitFor();assert.equal((await app.api('task-templates'))[0].spec.videoModelId,saved);
  await page.locator('[data-macro-edit]').click();assert.equal(await task.locator('[name=videoModelId]').inputValue(),saved);await task.locator('[name=taskMode]').selectOption('direct');assert.equal(await page.locator('#task-video-model-choice').isVisible(),false);
  await page.locator('.task-video-model').scrollIntoViewIfNeeded();await page.screenshot({path:'.data/video-model-config-preview.png'});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
