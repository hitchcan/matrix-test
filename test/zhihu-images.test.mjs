import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pasteZhihuImages} from '../zhihu-images.mjs';
import {richComparison} from '../rich-check.mjs';
import {observeRecovery} from '../workflow/recovery-page.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64');
const html='<p><strong>正文开头</strong></p><p><img src="data:image/png;base64,'+png.toString('base64')+'"></p><p>正文结尾</p>';
for(const broken of [false,true])test('知乎正文原生图片粘贴、保留图文顺序和格式，上传未完成禁止通过：'+broken,async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',route=>route.request().url().includes('zhimg.com')?route.fulfill({contentType:'image/png',body:png}):route.fulfill({contentType:'text/html',body:`<div id="body" contenteditable="true"></div><script>
  window.images=0;window.htmlPastes=[];
  document.querySelector('#body').addEventListener('paste',e=>{
    e.preventDefault();
    if(e.clipboardData.files.length){window.images++;document.execCommand('insertHTML',false,'<img src="${broken?'blob:https://zhuanlan.zhihu.com/failed':'https://pic1.zhimg.com/test.png'}">');}
    else {const html=e.clipboardData.getData('text/html');window.htmlPastes.push(html);document.execCommand('insertHTML',false,html);}
  });</script>`}));
  const page=await context.newPage();await page.goto('https://zhuanlan.zhihu.com/write');const field=page.locator('#body');
  if(broken)await assert.rejects(pasteZhihuImages(field,html,{timeoutMs:300}),e=>e.code==='image_upload_failed'&&e.message.includes('1/1'));
  else {
    await pasteZhihuImages(field,html,{timeoutMs:2000});assert.equal((await richComparison(field,html)).valid,true);
    assert.equal(await field.evaluate(root=>[...root.childNodes].map(n=>n.nodeName).join(',')),'P,P,P');
    assert.equal(await field.locator('p').nth(1).locator('img').count(),1);
    assert.ok(!(await field.innerText()).includes('MATRIXIMAGE'));
  }
  assert.equal(await page.evaluate(()=>window.images),1);
  assert.ok(await page.evaluate(()=>window.htmlPastes.every(html=>!html.includes('<img'))));
  if(broken)assert.equal((await richComparison(field,html)).valid,false);
});

test('知乎图片空注释的 18 字提示不计入正文，真实注释、普通同名正文和坏图仍受校验',async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',r=>r.request().url().includes('zhimg.com')?r.fulfill({contentType:'image/png',body:png}):r.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="body" contenteditable="true"></div>'}));
  await page.goto('https://zhuanlan.zhihu.com/write');
  await page.locator('#body').evaluate(root=>root.innerHTML='<p><strong>正文开头</strong></p><p><span class="Image-captionContainer" contenteditable="false"><img src="https://pic1.zhimg.com/test.png"><span class="Image-caption Image-captionV2 is-placeholder">添加图片注释，不超过 140 字（可选）</span></span></p><p>正文结尾</p>');
  const field=page.locator('#body');await field.locator('img').evaluate(img=>img.decode());
  let result=await richComparison(field,html);assert.equal(result.valid,true);assert.equal(result.ignoredUiChars,18);
  await field.locator('.Image-caption').evaluate(n=>n.classList.remove('is-placeholder'));
  result=await richComparison(field,html);assert.equal(result.valid,false);assert.equal(result.ignoredUiChars,0);
  await field.locator('.Image-caption').evaluate(n=>{n.classList.add('is-placeholder');n.textContent='用户实际添加的图片说明';});
  assert.equal((await richComparison(field,html)).valid,false);
  await field.locator('.Image-caption').evaluate(n=>n.textContent='添加图片注释，不超过 140 字（可选）');
  await field.evaluate(root=>root.insertAdjacentHTML('beforeend','<p>添加图片注释，不超过 140 字（可选）</p>'));
  assert.equal((await richComparison(field,html)).valid,false);
  await field.locator('p').last().evaluate(n=>n.remove());await field.locator('img').evaluate(n=>n.src='blob:https://zhuanlan.zhihu.com/failed');
  result=await richComparison(field,html);assert.equal(result.valid,false);assert.ok(result.missing.includes('image_upload'));
});

test('重试图片导入时清空原稿及图片控件，不受图片注释焦点干扰',async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',route=>route.request().url().includes('zhimg.com')?route.fulfill({contentType:'image/png',body:png}):route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="body" contenteditable="true"></div><script>
  document.querySelector('#body').addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertHTML',false,e.clipboardData.files.length?'<span contenteditable="false" class="Image-captionContainer"><img src="https://pic1.zhimg.com/test.png"><span class="Image-caption is-placeholder">添加图片注释，不超过 140 字（可选）</span></span>':e.clipboardData.getData('text/html'));});</script>`}));
  const page=await context.newPage();await page.goto('https://zhuanlan.zhihu.com/write');const field=page.locator('#body');
  await pasteZhihuImages(field,html,{timeoutMs:2000});assert.equal((await richComparison(field,html)).valid,true);
  await field.locator('.Image-caption').click();await pasteZhihuImages(field,html,{timeoutMs:2000});
  const result=await richComparison(field,html);assert.equal(result.valid,true);assert.equal(result.ignoredUiChars,18);assert.equal(await field.locator('img').count(),1);
});

test('图片恢复能力仅在可信故障码下开放，过期 token 不上传或提交',async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<p>图片编辑区</p>'}));await page.goto('https://zhuanlan.zhihu.com/write');
  const snapshot=await observeRecovery(page,['zhuanlan.zhihu.com'],{failureCode:'image_upload_failed'});
  assert.equal(snapshot.observation.failureCode,'image_upload_failed');assert.ok(snapshot.observation.actions.includes('retry_image_upload'));
  assert.equal(await snapshot.perform('retry_image_upload'),true);assert.equal(await snapshot.perform('retry_image_upload'),false);await snapshot.dispose();
  const normal=await observeRecovery(page,['zhuanlan.zhihu.com']);assert.ok(!normal.observation.actions.includes('retry_image_upload'));assert.equal(await normal.perform('retry_image_upload'),false);await normal.dispose();
});
