import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {channelsAi} from '../wechat-channels.mjs';
import {PublishAdapter} from '../browser-runtime.mjs';

const declaration=readFileSync(new URL('fixtures/channels-selected-declaration.html',import.meta.url),'utf8');
const rules=JSON.parse(readFileSync(new URL('../config/adapters.json',import.meta.url),'utf8'));
const rule=rules.channels.video;

async function selectedPage(t){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<wujie-app><template shadowrootmode="open"><div class="post-desc-box"><div class="input-editor" contenteditable="true"></div></div>${declaration}</template></wujie-app>`}));
  await page.goto(rule.url);
  await page.evaluate(()=>{
    const root=document.querySelector('wujie-app').shadowRoot,control=root.querySelector('.mark-tag-select'),display=control.querySelector('.select-display'),options=control.querySelector('.mark-tag-options');
    window.declarationTrace=[];
    window.setDeclaration=(value,open)=>{
      control.classList.toggle('has-value',!!value);control.classList.toggle('is-open',open);
      const span=document.createElement('span');span.className=value?'select-value':'select-placeholder';span.textContent=value||'选择视频标注';display.replaceChildren(span);
      for(const option of options.querySelectorAll('.mark-tag-option'))option.classList.toggle('is-selected',!!value&&option.querySelector('.option-main').textContent===value);
      options.style.display=open?'block':'none';
    };
    const value=()=>display.querySelector('.select-value')?.textContent||'';
    control.onclick=()=>{
      const open=!control.classList.contains('is-open');window.declarationTrace.push({action:'toggle',open});
      window.setDeclaration(open&&window.restoreDefault?'含AI生成内容':value(),open);
    };
    for(const option of options.querySelectorAll('.mark-tag-option'))option.onclick=e=>{
      e.stopPropagation();const chosen=option.querySelector('.option-main').textContent,already=chosen===value();
      window.declarationTrace.push({action:'option',chosen,cancelled:already});
      window.setDeclaration(already?'':chosen,false);
    };
  });
  return page;
}

test('新HTML中已选AI且菜单打开：只关闭，重复准备和提交核对不点击橙色选项',async t=>{
  const page=await selectedPage(t);
  assert.equal(await page.locator('.mark-tag-option.is-selected .option-main').innerText(),'含AI生成内容');
  await channelsAi(page,true,rule);await channelsAi(page,true,rule);await channelsAi(page,true,rule,{verifyOnly:true});
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[{action:'toggle',open:false}]);
  assert.equal(await page.locator('.select-value').textContent(),'含AI生成内容');
  assert.equal(await page.locator('.mark-tag-option.is-selected').count(),1);
});

test('提交前复核只读：开着的已选菜单或不一致声明均不重选',async t=>{
  const page=await selectedPage(t),adapter=new PublishAdapter({},rules,()=>null);
  const content={type:'video',publication:{aiAssisted:true}};
  await assert.rejects(adapter.applyAiDisclosure(page,rule,content),error=>error.noAutoRecovery===true&&/菜单仍打开/.test(error.message));
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[]);
  await page.evaluate(()=>window.setDeclaration('无需标注',false));
  await assert.rejects(adapter.applyAiDisclosure(page,rule,content),/与任务不一致/);
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[]);
  await page.evaluate(()=>window.setDeclaration('含AI生成内容',false));
  assert.equal((await adapter.applyAiDisclosure(page,rule,content)).state,'verified');
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[]);
});

test('打开菜单期间恢复了默认AI值：重新读状态，绝不点击同一选项取消它',async t=>{
  const page=await selectedPage(t);await page.evaluate(()=>{window.setDeclaration('',false);window.restoreDefault=true;});
  await channelsAi(page,true,rule);
  assert.equal(await page.locator('.select-value').textContent(),'含AI生成内容');
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[{action:'toggle',open:true},{action:'toggle',open:false}]);
});

test('未选中时只选一次并自动关闭；重复核对不重新打开',async t=>{
  const page=await selectedPage(t);await page.evaluate(()=>window.setDeclaration('',false));
  await channelsAi(page,true,rule);await channelsAi(page,true,rule,{verifyOnly:true});await channelsAi(page,true,rule);
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[{action:'toggle',open:true},{action:'option',chosen:'含AI生成内容',cancelled:false}]);
});

test('Wujie下渲染文本读取异常仍以明确的select-value和选中标记判断',async t=>{
  const page=await selectedPage(t);await page.locator('.select-display').evaluate(n=>Object.defineProperty(n,'innerText',{get:()=>''}));
  await channelsAi(page,true,rule);
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[{action:'toggle',open:false}]);
});

test('显示值和橙色选项不一致时暂停，提供状态诊断而不盲点',async t=>{
  const page=await selectedPage(t);
  await page.locator('.mark-tag-option.is-selected .option-main').evaluate(n=>n.textContent='无需标注');
  await assert.rejects(channelsAi(page,true,rule),error=>error.code==='channels_declaration_state'&&error.noAutoRecovery===true&&/状态一致=false/.test(error.message));
  assert.deepEqual(await page.evaluate(()=>window.declarationTrace),[]);
});
