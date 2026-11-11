import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {applyZhihuAi} from '../zhihu-ai.mjs';

async function pageFor(t,initial='无声明',role=false){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.setContent(`<!doctype html><meta charset="utf-8"><div role="dialog"><h2>发布文章</h2><div><span>创作声明：</span><button id="choice" onclick="openMenu()">${initial}</button></div><button onclick="window.posts=(window.posts||0)+1">发布文章</button></div><div hidden>包含 AI 辅助创作</div>
  <script>
  function selectValue(value){const old=document.querySelector('#choice');old.outerHTML='<button id="choice" onclick="openMenu()">'+value+'</button>';document.querySelector('#choices').remove();}
  function openMenu(){if(document.querySelector('#choices')){document.querySelector('#choices').remove();return;}setTimeout(()=>{const menu=document.createElement('div');menu.id='choices';${role?`menu.setAttribute('role','listbox');`:''}for(const value of ['无声明','包含 AI 辅助创作']){const item=document.createElement('div');${role?`item.setAttribute('role','option');`:''}item.textContent=value;item.onclick=()=>selectValue(value);menu.append(item);}document.body.append(menu);},100);}
  </script>`);
  return page;
}

test('知乎声明下拉：点开创作声明，选择普通div菜单项，回读AI状态，不点击发布',async t=>{
  const page=await pageFor(t);
  const result=await applyZhihuAi(page,true);
  assert.equal(result.checked,true);assert.equal(result.kind,'zhihu-declaration');
  assert.equal(await page.locator('#choice').innerText(),'包含 AI 辅助创作');
  assert.equal(await page.evaluate(()=>window.posts||0),0);
  // A repeated submit-time check must not reopen or toggle the selection off.
  assert.equal((await applyZhihuAi(page,true)).checked,true);assert.equal(await page.locator('#choices').count(),0);
});

test('知乎声明下拉：取消已有AI声明，选择无声明并回读',async t=>{
  const page=await pageFor(t,'包含 AI 辅助创作',true);
  const result=await applyZhihuAi(page,false);
  assert.equal(result.checked,false);assert.equal(await page.locator('#choice').innerText(),'无声明');
  assert.equal(await page.evaluate(()=>window.posts||0),0);
});

test('菜单已经展开时直接选择，不重复点击收起；保留其他已选非AI声明',async t=>{
  const page=await pageFor(t);
  await page.locator('#choice').click();await page.getByText('包含 AI 辅助创作',{exact:true}).filter({visible:true}).waitFor();
  assert.equal((await applyZhihuAi(page,true)).checked,true);
  await page.locator('#choice').evaluate(n=>n.textContent='个人观点，仅供参考');
  assert.equal((await applyZhihuAi(page,false)).checked,false);
  assert.equal(await page.locator('#choice').innerText(),'个人观点，仅供参考');
});

test('声明选项点击后未回显时不得当作已勾选',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{window.selectValue=()=>document.querySelector('#choices').remove();});
  await assert.rejects(applyZhihuAi(page,true,{timeout:400}),/未能从当前选项读回一致状态/);
  assert.equal(await page.evaluate(()=>window.posts||0),0);
});

test('原生声明下拉框支持选中和取消AI',async t=>{
  const page=await pageFor(t);
  await page.locator('#choice').evaluate(n=>n.outerHTML='<select id="choice"><option value="none">无声明</option><option value="ai">包含 AI 辅助创作</option></select>');
  assert.equal((await applyZhihuAi(page,true)).checked,true);
  assert.equal(await page.locator('#choice').inputValue(),'ai');
  assert.equal((await applyZhihuAi(page,false)).checked,false);
  assert.equal(await page.locator('#choice').inputValue(),'none');
});

test('单个“创作声明”按钮选择后文字被替换，仍可读回并取消AI',async t=>{
  const page=await pageFor(t);
  await page.locator('span').filter({hasText:'创作声明'}).evaluate(n=>n.remove());
  await page.locator('#choice').evaluate(n=>n.textContent='创作声明');
  assert.equal((await applyZhihuAi(page,true)).checked,true);
  assert.equal(await page.locator('#choice').innerText(),'包含 AI 辅助创作');
  assert.equal((await applyZhihuAi(page,false)).checked,false);
});

test('发布面板异步显示创作声明时等待控件，不误报缺失',async t=>{
  const page=await pageFor(t);
  await page.locator('#choice').evaluate(n=>{n.parentElement.style.display='none';setTimeout(()=>n.parentElement.style.display='block',200);});
  assert.equal((await applyZhihuAi(page,true)).checked,true);
});
