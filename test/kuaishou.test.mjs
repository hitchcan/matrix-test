import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {kuaishouEditorUrl,kuaishouUpload,kuaishouDescription,kuaishouAi,kuaishouPublishButton} from '../kuaishou-publisher.mjs';
import {watchKuaishouIdentity} from '../kuaishou-identity.mjs';
import {creatorIdentityReady} from '../creator-identity.mjs';
import {PublishAdapter} from '../browser-runtime.mjs';
import {platforms} from '../platform-catalog.mjs';

test('快手仅开放视频，官方发布地址严格校验，文案合并使用平台版本',()=>{
  assert.deepEqual(platforms.kuaishou.types,['video']);
  assert.equal(kuaishouEditorUrl('https://cp.kuaishou.com/article/publish/video?source=NewReco'),true);
  for(const url of ['http://cp.kuaishou.com/article/publish/video','https://cp.kuaishou.com.evil.test/article/publish/video','https://cp.kuaishou.com/profile'])assert.equal(kuaishouEditorUrl(url),false);
  assert.equal(kuaishouDescription({title:'统一标题',body:'统一简介',versions:{kuaishou:{title:'快手标题'}}}),'快手标题\n统一简介');
  assert.equal(kuaishouDescription({title:'同文',body:'同文'}),'同文');
});

test('快手受控浏览器：隐藏上传入口、唯一性、空身份',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<div class="user-info-dpd">相同昵称</div><div class="header-info-card"><div class="user-kwai-id"></div></div><input type="file" accept="video/*,.mp4" style="display:none">`}));
  await page.goto('https://cp.kuaishou.com/article/publish/video');
  const rules=JSON.parse(readFileSync(new URL('../config/adapters.json',import.meta.url))),rule=rules.kuaishou.video;
  const input=await kuaishouUpload(page,rule);
  await input.setInputFiles({name:'fixture.mp4',mimeType:'video/mp4',buffer:Buffer.from('controlled upload')});
  assert.equal(await input.evaluate(n=>n.files[0].name),'fixture.mp4');
  assert.equal(await creatorIdentityReady(page,'kuaishou',null,0,{timeoutMs:100}),null);
  await page.locator('.user-kwai-id').evaluate(n=>n.textContent='fixture-account');
  assert.equal((await creatorIdentityReady(page,'kuaishou',null,0,{timeoutMs:300})).platformId,'fixture-account');
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input type="file" accept="video/*">'));
  await assert.rejects(kuaishouUpload(page,rule),/入口不唯一/);
});

async function editor(t){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  const html=readFileSync(new URL('fixtures/kuaishou-saved-video.html',import.meta.url),'utf8');
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://cp.kuaishou.com/article/publish/video');
  await page.evaluate(()=>{
    const select=document.querySelector('.ant-select'),input=select.querySelector('input'),menu=select.querySelector('.ant-select-dropdown');
    const close=()=>{input.setAttribute('aria-expanded','false');menu.style.display='none';};close();
    select.querySelector('.ant-select-selector').addEventListener('click',event=>{if(event.target.closest('.ant-select-item-option'))return;menu.style.display='block';input.setAttribute('aria-expanded','true');});
    input.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
    for(const option of menu.querySelectorAll('.ant-select-item-option'))option.addEventListener('click',()=>{
      select.querySelector('.ant-select-selection-placeholder')?.remove();select.querySelector('.ant-select-selection-item')?.remove();
      const value=document.createElement('span');value.className='ant-select-selection-item';value.textContent=option.title;select.append(value);close();
      if(!select.querySelector('.ant-select-clear')){const clear=document.createElement('span');clear.className='ant-select-clear';clear.textContent='清除';clear.onclick=()=>{select.querySelector('.ant-select-selection-item')?.remove();};select.append(clear);}
    });
    window.clicks=0;document.querySelector('[class*="_button-primary_"]').onclick=()=>{window.clicks++;const result=document.createElement('div');result.textContent='发布成功';document.body.append(result);};
  });
  return {page,rules:JSON.parse(readFileSync(new URL('../config/adapters.json',import.meta.url)))};
}

test('快手保存结构：AI选中回读、清除及保留非AI声明，平台定时不得误提交',async t=>{
  const {page}=await editor(t);
  assert.equal((await kuaishouAi(page,true)).checked,true);
  assert.equal(await page.locator('.ant-select-selection-item').innerText(),'内容为AI生成');
  await kuaishouAi(page,false);assert.equal(await page.locator('.ant-select-selection-item').count(),0);
  await page.locator('.ant-select-selector').click();await page.locator('.ant-select-item-option[title="个人观点，仅供参考"]').click();
  await kuaishouAi(page,false);assert.equal(await page.locator('.ant-select-selection-item').innerText(),'个人观点，仅供参考');
  await page.getByRole('radio',{name:'定时发布',exact:true}).check();await assert.rejects(kuaishouPublishButton(page),/不是立即发布/);
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('快手准备和提交复核合并文案：改文阻断；成功只点击一次且不虚构ID',async t=>{
  const {page,rules}=await editor(t);const account={platform:'kuaishou',platform_id:'42',status:'connected'};
  // Fully intercepted fixture; preserve the initialized mock interactions on goto.
  const goto=page.goto.bind(page);page.goto=async()=>{};
  const runtime={open:async()=>({page}),check:async()=>({platformId:'42'})};
  const adapter=new PublishAdapter(runtime,rules,()=>null),content={type:'video',title:'测试标题',body:'测试简介',assetIds:[],publication:{aiAssisted:true}};
  await adapter.prepare(account,content);assert.equal(await page.locator('#work-description-edit').innerText(),'测试标题\n测试简介');
  await page.locator('#work-description-edit').fill('被修改');let gates=0;
  await assert.rejects(adapter.submit(account,content,async()=>gates++),/文案已变化/);assert.equal(gates,0);
  await page.locator('#work-description-edit').fill(kuaishouDescription(content));
  const receipt=await adapter.submit(account,content,async()=>gates++);assert.equal(gates,1);assert.equal(receipt.id,null);assert.equal(receipt.url,null);assert.equal(await page.evaluate(()=>window.clicks),1);
  await assert.rejects(adapter.submit(account,content,async()=>gates++),/已存在成功标志/);assert.equal(gates,1);page.goto=goto;
});

test('快手身份只观察官方当前账号成功响应，拒绝未登录、其他路径及过期证据',async()=>{
  let listener;const read=watchKuaishouIdentity({on:(name,fn)=>listener=fn});
  const send=(data,url='https://cp.kuaishou.com/rest/v2/creator/pc/authority/account/current')=>listener({url:()=>url,status:()=>200,json:async()=>data});
  await send({result:1,data:{userId:420,logined:false}});assert.equal(read(0),null);
  await send({result:1,data:{userId:420,logined:true}},'https://evil.test/rest/v2/creator/pc/authority/account/current');assert.equal(read(0),null);
  await send({result:1,data:{userId:420,logined:true}},'https://cp.kuaishou.com/rest/v2/creator/pc/authority/account/current?userId=42');assert.equal(read(0),null);
  await send({result:1,data:{userId:420,logined:true,userName:'同名账号'}});assert.equal(read(0).platformId,'420');assert.equal(read(Date.now()+1000),null);
});
