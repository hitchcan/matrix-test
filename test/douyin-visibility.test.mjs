import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {douyinVisibility} from '../douyin-visibility.mjs';
import {publicationIssues} from '../publication.mjs';
import {readFileSync} from 'node:fs';

test('可见范围支持原生选择、语义单选和无ARIA菜单，拒绝缺失/歧义/错误读回，兼容旧任务',async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
  assert.deepEqual(await douyinVisibility(page,undefined),{state:'unchanged',value:null});
  assert.ok(publicationIssues({publication:{mode:'auto',aiAssisted:false,douyinVisibility:'friends'}}).length);
  await assert.rejects(douyinVisibility(page,'private'),/无法唯一定位/);
  await page.setContent('<div><span>谁可以看</span><select><option value="a">公开</option><option value="b">私密：仅自己可见</option></select></div>');
  assert.equal((await douyinVisibility(page,'private')).value,'private');await douyinVisibility(page,'private',{}, {verifyOnly:true});
  await douyinVisibility(page,'public');assert.equal(await page.locator('select').inputValue(),'a');
  await page.setContent('<div><span>可见范围</span><div role="radiogroup"><label><input type="radio" name="v" checked>公开</label><label><input type="radio" name="v">仅自己可见</label></div></div>');
  await douyinVisibility(page,'private');assert.equal(await page.locator('input').nth(1).isChecked(),true);
  await page.setContent('<div><span>权限设置</span><label><input type="radio" name="v" checked>公开</label><label><input type="radio" name="v" style="display:none">私密</label></div>');
  await douyinVisibility(page,'private');assert.equal(await page.locator('input').nth(1).isChecked(),true);
  await page.setContent(`<div><span>谁可以看</span><div class="selectBox-a" onclick="document.querySelector('#menu').hidden=false"><span id="current">公开</span></div></div><div id="menu" hidden><div onclick="document.querySelector('#current').textContent='仅自己可见';this.parentElement.hidden=true">仅自己可见</div></div><div contenteditable="true">仅自己可见</div><button onclick="window.sent=true">发布</button>`);
  await douyinVisibility(page,'private');assert.equal(await page.locator('#current').textContent(),'仅自己可见');assert.equal(await page.evaluate(()=>window.sent),undefined);
  await page.locator('#current').evaluate(n=>n.textContent='公开');await assert.rejects(douyinVisibility(page,'private',{}, {verifyOnly:true}),/不一致/);
  await page.setContent('<div><span>谁可以看</span><select><option>公开</option></select></div>'.repeat(2));await assert.rejects(douyinVisibility(page,'private'),/无法唯一定位/);
});

test('保存的抖音真实谁可以看结构：隐藏checkbox单选、好友排除、相邻保存权限隔离和React替换后读回',async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
  const fixture=readFileSync(new URL('./fixtures/douyin-saved-visibility.html',import.meta.url),'utf8');
  await page.setContent(fixture+`<style>.radio-native-p6VBGt{position:absolute;opacity:0;width:0;height:0}label{display:inline-block;padding:8px}</style><div><span>保存权限</span><label><input id="save-permission" type="checkbox" checked>允许保存</label></div><button id="final" onclick="window.posts=(window.posts||0)+1">发布</button><script>
    document.addEventListener('click',e=>{const label=e.target.closest('label.radio-d4zkru');if(!label)return;e.preventDefault();const row=label.closest('.content-obt4oA'),selected=label.querySelector('input').value;
      // React replaces the field after a selection; checked HTML attributes stay stale.
      const fresh=row.cloneNode(true);row.replaceWith(fresh);fresh.querySelectorAll('label').forEach(l=>{const checked=l.querySelector('input').value===selected;l.querySelector('input').checked=checked;l.dataset.checked=String(checked);});
    });</script>`);
  assert.equal((await douyinVisibility(page,'private')).value,'private');await douyinVisibility(page,'private',{}, {verifyOnly:true});
  assert.equal(await page.locator('label[data-checked="true"]').innerText(),'仅自己可见');assert.equal(await page.locator('input[value="2"]').isChecked(),false);
  assert.equal(await page.locator('#save-permission').isChecked(),true);assert.equal(await page.evaluate(()=>window.posts||0),0);
  await douyinVisibility(page,'public');assert.equal(await page.locator('input[value="0"]').isChecked(),true);
  await assert.rejects(douyinVisibility(page,'private',{}, {verifyOnly:true}),/不一致/);
  // Two selected boxes or mismatched visual/native state must never pass final validation.
  await page.locator('input[value="1"]').evaluate(n=>{n.checked=true;n.closest('label').dataset.checked='true';});
  await assert.rejects(douyinVisibility(page,'private',{}, {verifyOnly:true}),/不一致/);
  await page.locator('input[value="0"]').evaluate(n=>{n.checked=false;});
  await assert.rejects(douyinVisibility(page,'private',{}, {verifyOnly:true}),/不一致/);
});
