import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {applyXhsAi} from '../xhs-disclosure.mjs';

async function pageFor(t,{selected=false,broken=false}={}){
 const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(3000);
 await page.setContent(`<!doctype html><meta charset="utf-8"><div contenteditable="true">笔记含AI合成内容</div>
 <div class="d-grid d-select-main d-select-main-prefix-indicator"><div class="d-select-prefix"></div><div class="d-select-content"><div class="d-text d-text-nowrap d-select-description --color-text-title">${selected?'笔记含AI合成内容':'添加内容类型声明'}</div><div class="d-text d-select-placeholder d-text-ellipsis d-text-nowrap"></div></div><div class="d-select-suffix"></div></div>
 <span class="permission-info"><span class="permission-info-declaration"><span class="permission-info-text">笔记含AI合成内容</span></span></span>
 <div id="popup" hidden><div class="d-option"><div class="d-option-description"><div class="d-option-name"><span>笔记含AI合成内容</span></div></div></div></div><button id="publish" onclick="window.posts++">发布</button>
 <script>window.posts=0;window.opens=0;document.querySelector('.d-select-main').onclick=()=>{window.opens++;const p=document.querySelector('#popup');p.hidden=!p.hidden;const o=p.querySelector('.d-option');o.classList.toggle('--selected',document.querySelector('.d-select-description').textContent==='笔记含AI合成内容');};document.querySelector('.d-option').onclick=()=>{${broken?'return;':"const value=document.querySelector('.d-select-description');value.textContent=value.textContent==='笔记含AI合成内容'?'添加内容类型声明':'笔记含AI合成内容';document.querySelector('#popup').hidden=true;"}};</script>`);
 return page;
}
test('真实小红书结构：选择框、底部说明、隐藏菜单和正文四处同名，只读选择框',async t=>{
 const page=await pageFor(t,{selected:true});const result=await applyXhsAi(page,true);
 assert.equal(result.checked,true);assert.equal(result.kind,'xhs-select');assert.equal(result.value,'笔记含AI合成内容');assert.equal(await page.evaluate(()=>window.opens),0);assert.equal(await page.evaluate(()=>window.posts),0);
});
test('小红书d-select选择后placeholder仍保留，选项DOM不卸载，也能核验并取消',async t=>{
 const page=await pageFor(t);assert.equal((await applyXhsAi(page,true)).checked,true);assert.equal(await page.locator('.d-select-placeholder').count(),1);assert.equal(await page.locator('.d-option').count(),1);
 assert.equal((await applyXhsAi(page,false,{timeout:200})).checked,false);assert.equal(await page.locator('.d-select-description').innerText(),'添加内容类型声明');assert.equal(await page.evaluate(()=>window.posts),0);
});
test('底部说明或菜单出现AI文字，不代表声明选择成功',async t=>{
 const page=await pageFor(t,{broken:true});await assert.rejects(applyXhsAi(page,true,{timeout:200}),/选择框当前值仍与任务选项不一致/);assert.equal(await page.evaluate(()=>window.posts),0);
});
test('真正两个内容类型选择框仍阻断，不任取一个',async t=>{
 const page=await pageFor(t,{selected:true});await page.locator('.d-select-main').evaluate(n=>n.parentElement.append(n.cloneNode(true)));await assert.rejects(applyXhsAi(page,true),/多个内容类型声明选择框/);
});
