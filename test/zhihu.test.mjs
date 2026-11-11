import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {BrowserRuntime} from '../browser-runtime.mjs';
import {createStudio} from '../server.mjs';
import {richComparison} from '../rich-check.mjs';

const fixture=`<!doctype html><html><head><meta charset="utf-8"></head><body>
<textarea placeholder="请输入标题"></textarea><div class="public-DraftEditor-content" contenteditable="true"></div>
<button class="css-new-publish-trigger" onclick="document.querySelector('[data-dialog]').hidden=false;setTimeout(()=>document.querySelector('#final').disabled=false,1000)">发布</button>
<div class="css-new-publish-dialog" data-dialog hidden><h2>发布文章</h2><div><span>创作声明：</span><button id="declaration" onclick="openDeclarations()">无声明</button></div>
<button id="final" disabled onclick="window.submitCount=(window.submitCount||0)+1;history.replaceState({},'','/p/987654321');document.querySelector('#done').hidden=false">发布文章</button></div>
<div id="done" hidden>发布成功</div>
<script>
function openDeclarations(){if(document.querySelector('#decl-menu'))return;const menu=document.createElement('div');menu.id='decl-menu';for(const value of ['无声明','包含 AI 辅助创作']){const item=document.createElement('div');item.textContent=value;item.onclick=()=>{document.querySelector('#declaration').textContent=value;menu.remove();};menu.append(item);}document.body.append(menu);}
document.querySelector('[contenteditable]').addEventListener('input',()=>setTimeout(()=>{
const root=document.querySelector('[contenteditable]');for(const n of root.querySelectorAll('strong'))n.outerHTML='<span style="font-weight:bold">'+n.innerHTML+'</span>';
for(const n of root.querySelectorAll('em'))n.outerHTML='<span style="font-style:italic">'+n.innerHTML+'</span>';
history.replaceState({},'','/p/123456789/edit');},30));</script></body></html>`;

test('知乎文章完整浏览器链路（受控页面）：样式span、异步粘贴、草稿URL变化、发布面板、隐藏AI控件及最终文章回执',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'matrix-zhihu-test-'));
  let context;
  const launches=[];
  const launcher={launchPersistentContext:async(directory,options)=>{
    launches.push(options.headless);
    context=await chromium.launchPersistentContext(directory,{...options,headless:true});
    await context.route('**/*',route=>route.request().url().endsWith('/api/v4/me')?route.fulfill({contentType:'application/json',body:JSON.stringify({id:'mock-user',url_token:'mock-zhihu',name:'回归测试'})}):route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
    return context;
  }};
  const runtime=new BrowserRuntime(dir,{launcher,headless:true});
  const studio=createStudio({dataDir:dir,browserRuntime:runtime,tickMs:10});
  await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await studio.close();const path=resolve(dir);if(dirname(path)!==resolve(tmpdir())||!basename(path).startsWith('matrix-zhihu-test-'))throw Error('测试目录无效');rmSync(path,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${studio.server.address().port}`;
  const state=()=>fetch(origin+'/api/state').then(r=>r.json());
  const token=(await state()).token;
  const post=async(path,body)=>{const r=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const a=(await post('accounts',{platform:'zhihu',name:'知乎长文章回归账号'})).body.id;
  await post(`accounts/${a}/open`,{});await post(`accounts/${a}/check`,{});
  const html=Array.from({length:37},(_,i)=>`<p><strong>格式段落${i}：${'回归内容'.repeat(30)}</strong>${i<3?'<em>斜体段落</em>':''}</p>`).join('');
  const created=await post('dispatch',{requestKey:'zhihu-article-fix',accountIds:[a],content:{type:'article',title:'专用自动发布回归',body:'富文本回归',bodyHtml:html,assetIds:[],versions:{},publication:{mode:'auto',aiAssisted:true}}});
  assert.equal(created.status,201);
  let job;const deadline=Date.now()+30000;
  do{job=(await state()).jobs[0];if(['submitted','needs_manual','unknown'].includes(job.state))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  assert.equal(job.state,'submitted',JSON.stringify(job.events));
  assert.ok(job.events.some(e=>e.state==='opening_settings'));
  assert.ok(launches.includes(false));assert.ok(launches.includes(true));assert.equal(runtime.sessions.get(a).headless,true);
  assert.equal(job.receipt.id,'987654321');assert.equal(job.receipt.url,'https://zhuanlan.zhihu.com/p/987654321');
  const page=runtime.sessions.get(a).page;
  assert.equal(await page.evaluate(()=>window.submitCount),1);assert.equal(await page.locator('#declaration').innerText(),'包含 AI 辅助创作');assert.equal(job.receipt.aiDisclosure.checked,true);
  assert.equal(await page.locator('strong').count(),0);assert.ok(await page.locator('span[style*="font-weight"]').count()>30);
  const compare=await richComparison(page.locator('[contenteditable]'),html);assert.equal(compare.valid,true);
  await page.locator('[contenteditable]').evaluate(n=>n.querySelector('span').style.fontWeight='normal');
  assert.equal((await richComparison(page.locator('[contenteditable]'),html)).valid,false);
  assert.equal((await post(`jobs/${job.id}/retry`,{})).status,409);
});
