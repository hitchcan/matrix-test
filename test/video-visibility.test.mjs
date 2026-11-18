import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {videoVisibility,visibilityIssues} from '../video-visibility.mjs';
import {PublishAdapter} from '../browser-runtime.mjs';
test('可见范围拒绝未知平台和选项',()=>{
  assert.deepEqual(visibilityIssues({kuaishou:'private',bilibili:'public'}),[]);
  assert.ok(visibilityIssues({unknown:'private'}).length);assert.ok(visibilityIssues({bilibili:'friends'}).length);
});
for(const platform of ['bilibili','kuaishou'])test(platform+'保存结构：设置、读回、变更阻断及原值保留',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const html=readFileSync(new URL('fixtures/'+platform+'-visibility.html',import.meta.url),'utf8');
  await page.setContent('<button id="more">更多设置 <span>（含声明与权益、视频元素、互动管理等）</span></button><div id="settings" '+(platform==='bilibili'?'hidden':'')+'>'+html+'</div>');
  await page.evaluate(()=>{document.querySelector('#more').onclick=()=>document.querySelector('#settings').hidden=false;for(const item of document.querySelectorAll('.check-radio-v2-container'))item.onclick=()=>{document.querySelectorAll('.check-radio-v2-box').forEach(n=>n.classList.remove('check-radio-v2-box-checked'));item.querySelector('.check-radio-v2-box').classList.add('check-radio-v2-box-checked');};for(const input of document.querySelectorAll('input[type=radio]'))input.name='scope';});
  await videoVisibility(page,platform,null);assert.equal(await page.locator('#settings').isVisible(),platform!=='bilibili');
  assert.equal((await videoVisibility(page,platform,'private')).value,'private');
  await videoVisibility(page,platform,'private',{verifyOnly:true});await videoVisibility(page,platform,'public');
  await assert.rejects(videoVisibility(page,platform,'private',{verifyOnly:true}),/已变化/);
});
test('人工将快手私密改为公开时，最终门禁前阻断',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const html=readFileSync(new URL('fixtures/kuaishou-visibility.html',import.meta.url),'utf8');
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<meta charset="utf-8">'+html+'<input id="title"><textarea id="body"></textarea><button id="submit">发布</button><p id="success" hidden>成功</p>'}));
  const url='https://cp.kuaishou.com/article/publish/video';await page.goto(url);await page.locator('input[type=radio]').evaluateAll(ns=>ns.forEach(n=>n.name='scope'));
  const account={platform:'kuaishou',status:'connected',platform_id:'id'},rule={url,title:'#title',body:'#body',submit:'#submit',success:'#success'};
  const adapter=new PublishAdapter({open:async()=>({page}),check:async()=>({platformId:'id'})},{kuaishou:{video:rule}},()=>null);
  const content={type:'video',title:'标题',body:'正文',assetIds:[],publication:{videoVisibility:{kuaishou:'private'}}};
  await adapter.prepare(account,content,{resumeRecovery:true});await videoVisibility(page,'kuaishou','public');let gate=0;
  await assert.rejects(adapter.submit(account,content,async()=>gate++),/可见范围已变化/);assert.equal(gate,0);
});
