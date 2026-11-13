import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createStudio} from '../server.mjs';
import {normalizeSchedule,occurrence} from '../workflow/task-schedule.mjs';
const iso=value=>new Date(value).toISOString();
const wait=async fn=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('等待任务超时');};
async function setup(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'matrix-task-calendar-'));let studio,base,token;
  const start=async()=>{studio=createStudio({dataDir:dir,tickMs:8,demoDelay:8,...options});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+studio.server.address().port;token=(await fetch(base+'/api/state').then(r=>r.json())).token;};await start();
  t.after(async()=>{await studio.close();const path=resolve(dir);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith('matrix-task-calendar-'));rmSync(path,{recursive:true,force:true});});
  const api=async(path,body)=>{const res=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();assert.ok(res.ok,JSON.stringify(data));return data;};
  return {api,get base(){return base;},get studio(){return studio;},restart:async()=>{await studio.close();await start();},upload:async(name,day='2026-11-12',mime='image/png')=>{
    const response=await fetch(base+'/api/assets',{method:'POST',headers:{'X-Studio-Token':token,'X-File-Name':encodeURIComponent(name),'X-Archive-Date':day,'Content-Type':mime},body:Buffer.from('controlled-test-media')});assert.equal(response.status,201);return (await response.json()).id;
  }};
}
const spec={topic:'原素材发布',style:'按备注挑选关于猫的素材',facts:'',targets:[{accountId:'demo-zhihu',type:'article'}],assetIds:[],mode:'auto',maxCalls:1};

test('北京时间日历频率：多时段、跨日星期、月末、闰月、截止时间及旧间隔兼容',()=>{
  const daily=normalizeSchedule({kind:'daily',startAt:'2026-11-12T10:00:00+08:00',times:['09:00','18:30','18:30']});
  assert.equal(daily.timezone,'Asia/Shanghai');assert.equal(iso(occurrence(daily,Date.parse(daily.startAt))),'2026-11-12T10:30:00.000Z');
  assert.equal(iso(occurrence(daily,Date.parse('2026-11-12T23:59:00+08:00'),true)),'2026-11-12T10:30:00.000Z');
  assert.equal(iso(occurrence(daily,Date.parse('2026-11-12T18:30:00+08:00')+1)),'2026-11-13T01:00:00.000Z');
  const weekly=normalizeSchedule({kind:'weekly',startAt:'2026-11-12T00:00:00+08:00',weekdays:[0],times:['00:05']});
  assert.equal(iso(occurrence(weekly,Date.parse(weekly.startAt))),'2026-11-14T16:05:00.000Z');
  const monthly=normalizeSchedule({kind:'monthly',startAt:'2028-02-01T00:00:00+08:00',monthDays:[29,31],times:['08:00'],endAt:'2028-03-01T00:00:00+08:00'});
  const at=occurrence(monthly,Date.parse(monthly.startAt));assert.equal(iso(at),'2028-02-29T00:00:00.000Z');assert.equal(occurrence(monthly,at+1),null);
  const old=normalizeSchedule({startAt:'2026-11-12T00:00:00Z',intervalSeconds:3600});assert.equal(old.kind,'interval');assert.equal(occurrence(old,Date.parse(old.startAt)+1),Date.parse(old.startAt)+3600000);
  for(const value of [{kind:'daily',times:[]},{kind:'weekly',weekdays:[]},{kind:'monthly',monthDays:[32]},{kind:'once',endAt:'2020-01-01Z'},{kind:'daily',times:['24:00']}])assert.throws(()=>normalizeSchedule({startAt:'2026-11-12T00:00:00Z',...value}));
});

test('无模型直接发布原视频，按素材轮换，快照备注不随编辑变化且不占LLM或视频生成名额',async t=>{
  let writes=0,videoCalls=0;const writer=async()=>{writes++;throw Error('不得调用');};writer.available=false;
  const app=await setup(t,{writer,videoProvider:{create:async()=>{videoCalls++;throw Error('不得生成');}}});
  const first=await app.upload('一.mp4','2026-11-12','video/mp4'),second=await app.upload('二.mp4','2026-11-12','video/mp4');
  await app.api('assets/'+first,{note:'原始备注一'});await app.api('assets/'+second,{note:'原始备注二'});
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,taskMode:'direct',style:'',maxCalls:0,maxMicros:0,assetIds:[first,second],targets:[{accountId:'demo-bilibili',type:'video'}]}});
  const run=await app.api('task-templates/'+template.id+'/run',{requestKey:'one'});
  await app.api('assets/'+first,{note:'后改备注'});
  const result=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='dispatched'&&r;});
  assert.equal(result.calls,0);assert.deepEqual(result.targets[0].artifact.assetIds,[first]);assert.equal(result.targets[0].artifact.body,spec.topic);assert.equal(result.snapshot.assetMetadata[first].note,'原始备注一');assert.equal(result.targets[0].artifact.publication.aiAssisted,false);assert.equal(result.videoTasks.length,0);
  const next=await app.api('task-templates/'+template.id+'/run',{requestKey:'two'});const r=await wait(async()=>{const r=await app.api('runs/'+next.id);return r.targets[0].state==='dispatched'&&r;});assert.deepEqual(r.targets[0].artifact.assetIds,[second]);assert.equal(writes,0);assert.equal(videoCalls,0);
  await app.restart();assert.equal((await app.api('state')).assets.find(a=>a.id===first).note,'后改备注');assert.equal((await app.api('runs/'+run.id)).snapshot.assetMetadata[first].note,'原始备注一');
});

test('agent 日期区间动态选材：含边界、新入库与备注；只发布原视频且不生成新成片',async t=>{
  const observed=[];const app=await setup(t,{writer:async input=>{observed.push(input);return {title:'猫咪视频',body:'依据备注的配文',assetIds:[input.assets.find(a=>a.note==='小猫玩球').id]};}});
  const outside=await app.upload('范围外.mp4','2026-11-10','video/mp4');await app.api('assets/'+outside,{note:'小猫玩球'});
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,taskMode:'select',assetRange:{from:'2026-11-11',to:'2026-11-12'},targets:[{accountId:'demo-bilibili',type:'video'}]}});
  const first=await app.upload('范围起点.mp4','2026-11-11','video/mp4'),end=await app.upload('范围终点.mp4','2026-11-12','video/mp4');
  await app.api('assets/'+first,{note:'小狗散步'});await app.api('assets/'+end,{note:'小猫玩球'});
  const image=await app.upload('类型不符.png','2026-11-12');
  const run=await app.api('task-templates/'+template.id+'/run',{requestKey:'select'});
  const result=await wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='dispatched'&&r;});
  assert.equal(observed[0].taskMode,'select');assert.deepEqual(new Set(observed[0].assets.map(a=>a.id)),new Set([first,end]));assert.ok(!observed[0].assets.some(a=>a.id===outside||a.id===image));assert.match(observed[0].assets.find(a=>a.id===end).description,/小猫玩球/);
  assert.deepEqual(result.targets[0].artifact.assetIds,[end]);assert.equal(result.targets[0].artifact.publication.aiAssisted,true);assert.equal(result.videoTasks.length,0);assert.equal(result.calls,1);
  const context=await app.api('agent/actions',{name:'context',arguments:{}});assert.equal(context.result.assets.find(a=>a.id===end).note,'小猫玩球');
});

test('日历多时段提前准备、重启分发及断线仅执行最近一期',async t=>{
  let ms=Date.parse('2026-11-12T08:55:00+08:00'),writes=0;
  const app=await setup(t,{clock:()=>iso(ms),writer:async()=>({title:'日历成品',body:'事实正文 '+(++writes),assetIds:[]})});
  await app.api('task-templates',{enabled:true,spec:{...spec,facts:'事实',schedule:{kind:'daily',startAt:'2026-11-12T00:00:00+08:00',times:['09:00','18:00'],prepareLeadSeconds:300}}});
  await wait(()=>writes===1);const first=(await app.api('runs'))[0];await wait(async()=>(await app.api('runs/'+first.id)).targets[0].state==='ready');assert.equal((await app.api('state')).jobs.length,0);
  await app.restart();ms=Date.parse('2026-11-12T09:00:00+08:00');await wait(async()=>(await app.api('state')).jobs.length===1);assert.equal(writes,1);
  ms=Date.parse('2026-11-15T18:01:00+08:00');await wait(async()=>(await app.api('runs')).length===2);assert.equal((await app.api('runs'))[0].scheduled_for,'2026-11-15T10:00:00.000Z');
  await wait(()=>writes===2);await app.restart();await new Promise(r=>setTimeout(r,60));assert.equal((await app.api('runs')).length,2);
});

test('工作台日期与时分选择、三种任务方式、备注编辑搜索和移动端布局',async t=>{
  const app=await setup(t);const asset=await app.upload('图库素材.png');
  await app.api('model-settings',{create:true,name:'已保存agent',endpoint:'http://127.0.0.1:1234/chat',model:'configured-agent',key:''});
  await app.api('video-settings',{create:true,name:'已保存视频',provider:'json',endpoint:'http://127.0.0.1:1234/jobs',model:'configured-video',key:''});
  const {chromium}=await import('playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.base+'/#assets');const longNote='中文备注'.repeat(500);await page.locator('#library-upload-note').fill(longNote);
  await page.locator('#library-upload').setInputFiles({name:'批量备注.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64')});
  await wait(async()=>(await app.api('state')).assets.some(a=>a.note===longNote));
  await page.locator('[data-edit-asset="'+asset+'"]').click();await page.locator('[name=note]').fill('猫咪玩球，适合宠物账号');await page.locator('#asset-edit-form button[type=submit]').click();await page.locator('#detail').waitFor({state:'hidden'});
  await page.locator('#library-search').fill('宠物');assert.equal(await page.locator('[data-asset-id]').count(),1);
  await page.goto(app.base+'/#macros');const form=page.locator('#macro-form');
  for(const key of ['agent-model','video-model'])assert.equal(await page.locator('[data-task-section='+key+']').evaluate(n=>n.open),false);
  const modelSummary=page.locator('[data-task-section=agent-model]>summary');await modelSummary.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#model-settings-form').isVisible(),true);await modelSummary.click();
  await page.locator('[data-task-section=content]>summary').click();await form.getByRole('button',{name:'保存任务',exact:true}).click();assert.equal(await page.locator('[data-task-section=content]').evaluate(n=>n.open),true);
  await form.locator('[name=taskMode]').selectOption('direct');assert.equal(await form.locator('[name=style]').getAttribute('required'),null);
  await form.locator('[name=douyinVisibility]').selectOption('private');await form.locator('[name=topic]').fill('宠物素材');await form.locator('[name=target][value=demo-zhihu][data-macro-type=article]').check();await form.locator('[name=asset][value="'+asset+'"]').check();
  await page.locator('[data-task-section=materials]>summary').click();assert.equal(await form.locator('[name=asset][value="'+asset+'"]').isChecked(),true);assert.equal(await form.locator('[name=topic]').inputValue(),'宠物素材');
  await page.locator('[data-task-section=accounts]>summary').click();
  await form.locator('[name=scheduleKind]').selectOption('weekly');await form.locator('[name=startDate]').fill('2027-01-01');await form.locator('[name=startHour]').selectOption('08');await form.locator('[name=startMinute]').selectOption('00');
  for(const checkbox of await form.locator('[name=weekdays]').all())await checkbox.uncheck();await form.locator('[name=weekdays][value="1"]').check();await form.locator('[name=slotHour]').selectOption('09');await form.locator('[name=slotMinute]').selectOption('30');await form.locator('#task-add-slot').click();await form.locator('[name=slotHour]').nth(1).selectOption('18');
  await form.locator('[name=scheduleKind]').scrollIntoViewIfNeeded();await page.screenshot({path:'.data/task-calendar-preview.png'});
  await form.getByRole('button',{name:'保存任务',exact:true}).click();await page.locator('[data-macro-edit]').waitFor();let saved=(await app.api('task-templates'))[0];assert.equal(saved.spec.douyinVisibility,'private');assert.equal(saved.spec.taskMode,'direct');assert.equal(saved.spec.schedule.timezone,'Asia/Shanghai');assert.deepEqual(saved.spec.schedule.times,['09:30','18:00']);assert.deepEqual(saved.spec.schedule.weekdays,[1]);assert.equal(saved.next_at,'2027-01-04T01:30:00.000Z');
  await page.locator('[data-macro-edit]').click();
  assert.equal(await page.locator('[data-task-section=materials]').evaluate(n=>n.open),false);
  for(const key of ['content','materials'])if(!await page.locator('[data-task-section='+key+']').evaluate(n=>n.open))await page.locator('[data-task-section='+key+']>summary').click();
  assert.equal(await form.locator('[name=douyinVisibility]').inputValue(),'private');assert.equal(await form.locator('[name=startDate]').inputValue(),'2027-01-01');await form.locator('[name=taskMode]').selectOption('select');await form.locator('[name=style]').fill('按备注选择猫的图片');await form.locator('[name=rangeFrom]').fill('2026-11-11');await form.locator('[name=rangeTo]').fill('2026-11-12');await form.getByRole('button',{name:'保存修改'}).click();await wait(async()=>{saved=(await app.api('task-templates'))[0];return saved.spec.taskMode==='select';});assert.deepEqual(saved.spec.assetRange,{from:'2026-11-11',to:'2026-11-12'});
  await page.screenshot({path:'.data/task-folds-preview.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.data/task-folds-mobile-preview.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);assert.equal((await app.api('state')).assets.find(a=>a.id===asset).note,'猫咪玩球，适合宠物账号');
});

test('区间无可用素材、超过范围上限及越权素材ID不调用发布，不在错误时另选范围外素材',async t=>{
  let calls=0,outside;
  const app=await setup(t,{writer:async()=>{calls++;return {title:'越界选择',body:'受控测试',assetIds:[outside]};}});
  outside=await app.upload('范围外.png','2026-11-01');
  const template=await app.api('task-templates',{enabled:true,spec:{...spec,taskMode:'select',assetRange:{from:'2026-11-11',to:'2026-11-12'}}});
  const start=async key=>{const run=await app.api('task-templates/'+template.id+'/run',{requestKey:key});return wait(async()=>{const r=await app.api('runs/'+run.id);return r.targets[0].state==='blocked'&&r;});};
  let result=await start('empty');assert.equal(result.targets[0].reason,'insufficient_assets');assert.equal(result.calls,0);assert.equal(calls,0);
  await app.upload('范围内.png');result=await start('outside');assert.equal(result.targets[0].reason,'invalid_artifact');assert.equal(calls,1);assert.equal((await app.api('state')).jobs.length,0);
  for(let i=0;i<100;i++)await app.upload('受控'+i+'.png');result=await start('too-many');assert.equal(result.targets[0].reason,'asset_range_limit');assert.equal(result.calls,0);assert.equal(calls,1);
});
