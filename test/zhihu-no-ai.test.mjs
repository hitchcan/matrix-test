import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
import {fileURLToPath} from 'node:url';

async function setup(t,declaration){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><textarea placeholder="请输入标题"></textarea><div class="public-DraftEditor-content" contenteditable="true"></div><button class="PublishPanel-triggerButton" onclick="document.querySelector('.PublishPanel-content').hidden=false">发布</button><section class="PublishPanel-content" hidden><h2>发布设置</h2>${declaration}<button onclick="window.posts=(window.posts||0)+1;history.replaceState({},'','/p/123456')">发布文章</button></section>`}));
  const page=await context.newPage();const runtime={setMode:async()=>{},check:async()=>({platformId:'no-ai-user'}),open:async()=>({page})};
  const adapter=new PublishAdapter(runtime,loadAdapterRules(fileURLToPath(new URL('..',import.meta.url))),()=>null);
  const account={id:'fixture',platform:'zhihu',platform_id:'no-ai-user',status:'connected'};
  const content={type:'article',title:'不添加AI声明的文章',body:'正文可以提及包含 AI 辅助创作',assetIds:[],publication:{mode:'auto',aiAssisted:false}};
  return {page,adapter,account,content};
}

for(const [name,declaration,checked] of [
  ['声明控件完全缺失','',null],
  ['当前实际Select-button显示无声明','<div class="Select-button" onclick="window.menuOpened=true"><span>无声明</span></div>',false],
  ['未知的新声明结构','<div class="unknown-declaration" onclick="window.menuOpened=true">设置声明</div>',null],
])test('知乎不勾选AI可填写并提交，且不操作待修菜单：'+name,async t=>{
  const {page,adapter,account,content}=await setup(t,declaration);
  const prepared=await adapter.prepare(account,content);assert.equal(prepared.aiDisclosure.state,checked===false?'applied':'not_requested');assert.equal(prepared.aiDisclosure.checked,checked);
  assert.equal(await page.locator('textarea').inputValue(),content.title);assert.equal(await page.locator('[contenteditable]').innerText(),content.body);
  let clicked=false;const receipt=await adapter.submit(account,content,()=>clicked=true);
  assert.equal(clicked,true);assert.equal(await page.evaluate(()=>window.posts),1);assert.equal(await page.evaluate(()=>window.menuOpened),undefined);
  assert.equal(receipt.id,'123456');assert.equal(receipt.aiDisclosure.checked,checked);
});

test('知乎原来已经选中AI声明时可先填写，最终提交前提示人工取消，不冒认已取消',async t=>{
  const {page,adapter,account,content}=await setup(t,'<div class="Select-button" onclick="window.menuOpened=true"><span>包含 AI 辅助创作</span></div>');
  const prepared=await adapter.prepare(account,content);assert.equal(prepared.aiDisclosure.state,'pending');assert.equal(await page.locator('textarea').inputValue(),content.title);
  let clicked=false;await assert.rejects(adapter.submit(account,content,()=>clicked=true),/取消声明/);assert.equal(clicked,false);assert.equal(await page.evaluate(()=>window.posts||0),0);
  await page.locator('.Select-button').evaluate(n=>n.textContent='无声明');await adapter.submit(account,content,()=>clicked=true);assert.equal(clicked,true);
});

test('知乎明确勾选AI时仍保留原校验，不因不勾选通道的修复跳过声明',async t=>{
  const {page,adapter,account,content}=await setup(t,'');content.publication.aiAssisted=true;
  await adapter.prepare(account,content);let clicked=false;await assert.rejects(adapter.submit(account,content,()=>clicked=true),/无法唯一定位/);assert.equal(clicked,false);assert.equal(await page.evaluate(()=>window.posts||0),0);
});
