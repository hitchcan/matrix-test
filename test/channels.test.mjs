import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {PublishAdapter} from '../browser-runtime.mjs';
import {channelsEditorUrl,channelsText,channelsSuccessVisible,channelsAi,channelsScope,channelsPublishButton,watchChannelsIdentity} from '../wechat-channels.mjs';
const fixture=readFileSync(new URL('fixtures/channels-saved-video.html',import.meta.url),'utf8');
const rules=JSON.parse(readFileSync(new URL('../config/adapters.json',import.meta.url))),rule=rules.channels.video;
test('视频号短标题按截图限制替换不支持的标点，正文和原稿保留',()=>{
  const content={title:'测试，标题！A-B',body:'正文，保持！'};
  assert.equal(channelsText(content,'title'),'测试 标题 A B');assert.equal(channelsText(content,'body'),content.body);assert.equal(content.title,'测试，标题！A-B');
});
async function setup(t){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));await page.goto(rule.url);
  await page.evaluate(()=>{
    const root=document.querySelector('wujie-app').shadowRoot,select=root.querySelector('.mark-tag-select'),options=select.querySelector('.mark-tag-options'),display=select.querySelector('.select-display');
    window.fixtureSetDeclaration=(value,open)=>{
      select.classList.toggle('has-value',!!value);select.classList.toggle('is-open',open);
      const label=document.createElement('span');label.className=value?'select-value':'select-placeholder';label.textContent=value||'选择视频标注';display.replaceChildren(label);
      for(const option of options.querySelectorAll('.mark-tag-option'))option.classList.toggle('is-selected',!!value&&option.querySelector('.option-main').textContent===value);
      options.style.display=open?'block':'none';
    };
    const value=()=>select.querySelector('.select-value')?.textContent||'';
    window.fixtureSetDeclaration('',false);
    root.addEventListener('click',e=>{if(!select.contains(e.target))window.fixtureSetDeclaration(value(),false);});
    select.onclick=()=>window.fixtureSetDeclaration(value(),!select.classList.contains('is-open'));
    for(const option of options.querySelectorAll('.mark-tag-option'))option.onclick=e=>{e.stopPropagation();const picked=option.querySelector('.option-main').textContent;window.fixtureSetDeclaration(value()===picked?'':picked,false);};
    root.querySelector('input[type=radio][value="0"]').checked=true;
    const button=[...root.querySelectorAll('button')].find(n=>n.textContent.trim()==='发表');button.classList.remove('weui-desktop-btn_disabled');
    window.clicks=0;button.onclick=()=>{window.clicks++;if(!window.noReceipt){const result=document.createElement('p');result.textContent='发表成功';root.append(result);}};
  });return page;
}
test('视频号官方地址及当前账号身份响应严格核验',async()=>{
  assert.equal(channelsEditorUrl(rule.url),true);assert.equal(channelsEditorUrl('https://channels.weixin.qq.com.evil.test/platform/post/create'),false);
  let listener;const read=watchChannelsIdentity({on:(name,fn)=>listener=fn});
  const send=(json,url='https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data')=>listener({url:()=>url,status:()=>200,json:async()=>json});
  await send({errCode:1,data:{finderUser:{finderUsername:'wrong'}}});assert.equal(read(0),null);
  await send({errCode:0,data:{finderUser:{nickname:'仅昵称'}}});assert.equal(read(0),null);
  await send({errCode:0,data:{finderUser:{finderUsername:'wrong'}}},'https://evil.test/cgi-bin/mmfinderassistant-bin/auth/auth_data');assert.equal(read(0),null);
  await send({errCode:0,data:{finderUser:{finderUsername:'fixture@finder',nickname:'测试账号'}}});assert.equal(read(0).platformId,'fixture@finder');assert.equal(read(Date.now()+1000),null);
});
test('按官方开关状态关闭已选菜单：外部点击无效时不重选、不依赖过渡可见性',async t=>{
  const page=await setup(t);await page.evaluate(()=>{
    const root=document.querySelector('wujie-app').shadowRoot,old=root.querySelector('.mark-tag-select'),select=old.cloneNode(true);old.replaceWith(select);
    select.classList.add('is-open','has-value');select.querySelector('.select-display').innerHTML='<span class="select-value">含AI生成内容</span>';select.querySelectorAll('.mark-tag-option').forEach(n=>n.classList.toggle('is-selected',n.querySelector('.option-main').textContent==='含AI生成内容'));select.querySelector('.mark-tag-options').style.display='block';
    window.selectedAgain=0;select.onclick=()=>select.classList.toggle('is-open');
    for(const option of select.querySelectorAll('.mark-tag-option'))option.onclick=e=>{e.stopPropagation();window.selectedAgain++;select.querySelector('.select-display').textContent='选择视频标注';};
    // Model a visible closing layer and an ineffective outside-click directive.
    root.addEventListener('click',e=>{if(!select.contains(e.target))e.stopImmediatePropagation();},true);
    root.onclick=null;
    select.addEventListener('click',()=>{},true);
  });
  // Direct element listeners must receive clicks; prevent only the outside label.
  await page.evaluate(()=>{const root=document.querySelector('wujie-app').shadowRoot;root.querySelector('.label').onclick=e=>e.stopPropagation();});
  await channelsAi(page,true,rule);assert.equal(await page.locator('.mark-tag-select').evaluate(n=>n.classList.contains('is-open')),false);assert.equal(await page.evaluate(()=>window.selectedAgain),0);
});
test('真实保存结构与开放Shadow DOM：视频标注选择、取消、保留其他声明',async t=>{
  const page=await setup(t);await channelsAi(page,true,rule);assert.equal(await page.locator('.select-display').innerText(),'含AI生成内容');
  await channelsAi(page,false,rule);assert.equal(await page.locator('.select-display').innerText(),'无需标注');
  await page.locator('.select-display').click();await page.locator('.option-main').getByText('个人观点，仅供参考',{exact:true}).click();
  await channelsAi(page,false,rule);assert.equal(await page.locator('.select-display').innerText(),'个人观点，仅供参考');
  await page.locator('.select-display').click();await channelsAi(page,false,rule);assert.equal(await page.locator('.mark-tag-options').isVisible(),false);
});
test('声明选中先回显后延迟关闭，不再点击入口导致重开',async t=>{
  const page=await setup(t);await page.evaluate(()=>{
    const root=document.querySelector('wujie-app').shadowRoot,control=root.querySelector('.mark-tag-select'),display=control.querySelector('.select-display'),options=control.querySelector('.mark-tag-options');
    window.toggles=0;display.addEventListener('click',()=>window.toggles++);
    options.querySelectorAll('.mark-tag-option').forEach(n=>n.onclick=e=>{e.stopPropagation();window.fixtureSetDeclaration(n.querySelector('.option-main').textContent,false);options.style.display='block';setTimeout(()=>options.style.display='none',250);});
  });await channelsAi(page,true,rule);await channelsAi(page,true,rule);assert.equal(await page.evaluate(()=>window.toggles),1);
});
test('视频号完整准备与最终门禁：上传、独立文案、改文阻断、成功不虚构ID',async t=>{
  const page=await setup(t),account={platform:'channels',status:'connected',platform_id:'fixture@finder'};
  const adapter=new PublishAdapter({open:async()=>({page}),check:async()=>({platformId:account.platform_id})},rules,()=>({path:new URL('fixtures/channels-saved-video.html',import.meta.url),name:'controlled.mp4',mime:'video/mp4'}));
  const content={type:'video',title:'统一标题',body:'描述内容',assetIds:['test-video'],versions:{channels:{title:'视频号短标题'}},publication:{aiAssisted:true}};
  await adapter.prepare(account,content,{resumeRecovery:true});assert.equal(await page.locator(rule.title).inputValue(),'视频号短标题');assert.equal(await page.locator(rule.body).innerText(),'描述内容');
  assert.equal(await page.locator(rule.upload).evaluate(n=>n.files[0].name),'controlled.mp4');
  let gates=0;await page.locator(rule.body).fill('改文');await assert.rejects(adapter.submit(account,content,async()=>gates++),/文案已变化/);assert.equal(gates,0);
  await page.locator(rule.body).fill('描述内容');const receipt=await adapter.submit(account,content,async()=>gates++);assert.equal(gates,1);assert.equal(receipt.id,null);assert.equal(receipt.url,null);assert.equal(await page.evaluate(()=>window.clicks),1);
  await assert.rejects(adapter.submit(account,content,async()=>gates++),/已存在成功标志/);assert.equal(gates,1);
});
test('禁用按钮、平台定时、门禁拒绝以及无回执均不能冒认成功',async t=>{
  const page=await setup(t),button=page.getByRole('button',{name:'发表',exact:true});await button.evaluate(n=>n.classList.add('weui-desktop-btn_disabled'));
  await assert.rejects(channelsPublishButton(page,rule),/不可用/);await button.evaluate(n=>n.classList.remove('weui-desktop-btn_disabled'));
  await page.getByRole('radio',{name:'不定时',exact:true}).evaluate(n=>n.checked=false);await assert.rejects(channelsPublishButton(page,rule),/并非不定时/);
  await page.getByRole('radio',{name:'不定时',exact:true}).check();await page.locator(rule.title).fill('标题');await page.locator(rule.body).fill('描述');await channelsAi(page,false,rule);
  const account={platform:'channels',status:'connected',platform_id:'id'},runtime={open:async()=>({page}),check:async()=>({platformId:'id'})};
  const adapter=new PublishAdapter(runtime,{channels:{video:{...rule,resultTimeoutMs:30}}},()=>null),content={type:'video',title:'标题',body:'描述',publication:{aiAssisted:false}};
  await assert.rejects(adapter.submit(account,content,async()=>{throw Error('gate refused');}),/gate refused/);assert.equal(await page.evaluate(()=>window.clicks),0);
  await page.evaluate(()=>window.noReceipt=true);let gates=0;await assert.rejects(adapter.submit(account,content,async()=>gates++),/禁止自动重发/);assert.equal(gates,1);assert.equal(await page.evaluate(()=>window.clicks),1);
});
test('同源iframe兼容且多个候选编辑器不任选一个',async t=>{
  const page=await setup(t);await page.route('**/frame',route=>route.fulfill({contentType:'text/html',body:fixture}));
  await page.evaluate(()=>{document.querySelector('wujie-app').remove();const frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame);});
  await page.frameLocator('iframe').locator(rule.body).waitFor();assert.notEqual(await channelsScope(page,rule),page);
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame);});await page.frameLocator('iframe').nth(1).locator(rule.body).waitFor();
  await assert.rejects(channelsScope(page,rule),/唯一视频编辑器/);
});

 test('视频号仅自己可见映射草稿：只点击保存，发表成功不能冒充草稿回执',async t=>{
 const page=await setup(t);await page.evaluate(()=>{const root=document.querySelector('wujie-app').shadowRoot,save=document.createElement('button');save.textContent='保存草稿';window.saved=0;save.onclick=()=>{window.saved++;const p=document.createElement('p');p.textContent='草稿保存成功';root.append(p);};root.append(save);});
 const account={platform:'channels',status:'connected',platform_id:'id'},adapter=new PublishAdapter({open:async()=>({page}),check:async()=>({platformId:'id'})},rules,()=>null);
 const content={type:'video',title:'草稿标题',body:'草稿描述',assetIds:[],publication:{aiAssisted:false,videoVisibility:{channels:'private'}}};
 await adapter.prepare(account,content,{resumeRecovery:true});let gates=0;const receipt=await adapter.submit(account,content,async()=>gates++);
 assert.equal(receipt.action,'draft_saved');assert.equal(gates,1);assert.equal(await page.evaluate(()=>window.saved),1);assert.equal(await page.evaluate(()=>window.clicks),0);
 await assert.rejects(adapter.submit(account,content,async()=>gates++),/已存在成功标志/);assert.equal(gates,1);
 await page.getByText('草稿保存成功',{exact:true}).evaluate(n=>n.textContent='发表成功');assert.equal(await channelsSuccessVisible(page,content),false);
 });
