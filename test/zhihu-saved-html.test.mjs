import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {applyZhihuAi} from '../zhihu-ai.mjs';
import {zhihuPanel,zhihuFinalButton} from '../zhihu-article.mjs';

const saved=readFileSync(new URL('./fixtures/zhihu-saved-declaration.html',import.meta.url),'utf8');
test('用户保存的知乎真实声明行：零宽字符、帮助按钮、底栏范围与菜单回显',async t=>{
 const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(5000);await page.setContent(saved);
 await page.evaluate(()=>{
  window.posts=0;window.helps=0;window.opens=0;
  document.querySelector('#final-publish').onclick=()=>window.posts++;
  document.querySelector('label button').onclick=()=>window.helps++;
  const bind=()=>{document.querySelector('button[role="combobox"]').onclick=()=>{
   window.opens++;if(document.querySelector('#declaration-menu'))return;
   const menu=document.createElement('div');menu.id='declaration-menu';menu.setAttribute('role','listbox');
   for(const text of ['包含剧透','包含医疗建议','虚构创作','包含理财内容','包含 AI 辅助创作 作者对内容负责','无声明']){
    const option=document.createElement('div');option.setAttribute('role','option');option.textContent=text;
    option.onclick=()=>{const old=document.querySelector('button[role="combobox"]'),next=old.cloneNode(true);next.querySelector('span').textContent=text;old.replaceWith(next);menu.remove();bind();};menu.append(option);
   }
   document.body.append(menu);
  };};bind();
 });
 const panel=await zhihuPanel(page,{});assert.equal(await panel.getAttribute('data-matrix-inline-settings'),'true');
 assert.ok((await panel.innerText()).includes('创作声明'));assert.equal(await page.evaluate(()=>window.posts),0);
 const result=await applyZhihuAi(page,true);assert.equal(result.checked,true);
 assert.equal(await page.locator('[data-matrix-ai-trigger]').getAttribute('role'),'combobox');
 assert.equal(await page.evaluate(()=>window.helps),0);assert.equal(await page.evaluate(()=>window.posts),0);
 const opens=await page.evaluate(()=>window.opens);assert.equal((await applyZhihuAi(page,true)).checked,true);assert.equal(await page.evaluate(()=>window.opens),opens);
 assert.equal((await applyZhihuAi(page,false)).checked,false);assert.equal(await page.locator('button[role="combobox"]').innerText(),'无声明');
 assert.equal(await page.evaluate(()=>window.helps),0);assert.equal(await page.evaluate(()=>window.posts),0);
 assert.equal(await (await zhihuFinalButton(page,{})).getAttribute('id'),'final-publish');
});

test('保存文件结构中的真正两个声明控件不任选其一，也不点击帮助或发布',async t=>{
 const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent(saved);
 await page.locator('button[role="combobox"]').evaluate(n=>n.parentElement.append(n.cloneNode(true)));
 assert.equal(await applyZhihuAi(page,true,{timeout:100}),null);
 assert.equal(await page.locator('[data-matrix-ai-trigger]').count(),0);
});
