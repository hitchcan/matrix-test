import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
import {createStudio} from '../server.mjs';
import {workId} from '../workflow/creator-reader.mjs';
const fixture=readFileSync(new URL('./fixtures/bilibili-saved-article.html',import.meta.url),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64');
const account={id:'article-owner',platform:'bilibili',platform_id:'12345',status:'connected'};
const content={type:'article',title:'B站长文章受控测试',body:'这是标题格式这是正文内容列表内容',bodyHtml:'<h2>这是标题格式</h2><p><strong>这是正文内容</strong></p><ul><li>列表内容</li></ul>',assetIds:[],publication:{mode:'auto',aiAssisted:true}};
async function setup(t,html=fixture) {
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',r=>r.request().url().includes('hdslb.com')?r.fulfill({contentType:'image/png',body:png}):r.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  const runtime={check:async()=>({platformId:account.platform_id}),open:async()=>({page}),close:async()=>{}};
  const adapter=new PublishAdapter(runtime,loadAdapterRules(process.cwd()),()=>null);return {page,runtime,adapter};
}
test('B站新版长文章：富文本填写、声明读回、标准门禁一次发布和明确回执',async t=>{
  const {page,adapter}=await setup(t);const progress=[];
  await adapter.prepare(account,content,{onProgress:s=>progress.push(s)});
  assert.equal(await page.locator('textarea').inputValue(),content.title);assert.equal(await page.locator('.ProseMirror strong').innerText(),'这是正文内容');
  assert.equal(await page.locator('#ai').isChecked(),true);assert.equal(await page.locator('#original').isChecked(),false);
  let gates=0;const receipt=await adapter.submit(account,content,async()=>{assert.equal(await page.evaluate(()=>window.submits),0);gates++;});
  assert.equal(gates,1);assert.equal(await page.evaluate(()=>window.submits),1);assert.equal(receipt.simulated,false);assert.equal(receipt.id,null);assert.match(receipt.evidence,/已提交成功/);
  await assert.rejects(adapter.submit(account,content,()=>gates++),/已存在成功标志/);assert.equal(gates,1);
});
test('B站长文章原生图片上传，空注释不计入正文且不静默丢图',async t=>{
  const {page,adapter}=await setup(t);const c={...content,bodyHtml:content.bodyHtml+'<p><img src="data:image/png;base64,'+png.toString('base64')+'"></p>'};
  await adapter.prepare(account,c);assert.equal(await page.evaluate(()=>window.imagePastes),1);assert.equal(await page.locator('.ProseMirror img').count(),1);
  let gates=0;await adapter.submit(account,c,()=>gates++);assert.equal(gates,1);
});
test('声明缺失、设置异常、文案变动及失败回执均不绕过 B站长文章门禁',async t=>{
  const {page,adapter}=await setup(t);let gates=0;const gate=()=>gates++;
  await adapter.prepare(account,content);await page.locator('#ai-item').evaluate(n=>n.remove());
  await assert.rejects(adapter.submit(account,content,gate),/未显示 AI/);assert.equal(gates,0);
  await adapter.prepare(account,content);await page.locator('#schedule').check();await assert.rejects(adapter.submit(account,content,gate),/定时发布/);
  await page.locator('#schedule').uncheck();await page.locator('#cover').check();await assert.rejects(adapter.submit(account,content,gate),/封面未上传完成/);
  await page.locator('#cover').uncheck();await page.locator('.ProseMirror').fill('被修改的正文');await assert.rejects(adapter.submit(account,content,gate),/正文检查未通过/);
  assert.equal(gates,0);await adapter.prepare(account,content);await page.evaluate(()=>window.failSubmit=true);
  await assert.rejects(adapter.submit(account,content,gate),/结果待核对/);assert.equal(gates,1);assert.equal(await page.evaluate(()=>window.submits),1);
});
test('B站文章 URL 标识与视频兼容，保留大整数标识并拒绝伪造主机',()=>{
  assert.equal(workId('bilibili','https://www.bilibili.com/opus/1234567890123456789'),'1234567890123456789');
  assert.equal(workId('bilibili','https://www.bilibili.com/read/cv12345'),'cv12345');
  assert.equal(workId('bilibili','https://evil.example/opus/123'),null);
});

test('真实账号长文章目标可保存并分发，受控完整工作流经过持久门禁只提交一次',async t=>{
  const {page,runtime}=await setup(t),dir=mkdtempSync(join(tmpdir(),'matrix-bili-article-'));
  const studio=createStudio({dataDir:dir,browserRuntime:runtime,tickMs:10,writer:async()=>({title:content.title,body:'受控长文章正文',assetIds:[]})});
  t.after(async()=>{await studio.close();const path=resolve(dir);if(dirname(path)!==resolve(tmpdir())||!basename(path).startsWith('matrix-bili-article-'))throw Error('测试目录无效');rmSync(path,{recursive:true,force:true});});
  await new Promise(resolve=>studio.server.listen(0,'127.0.0.1',resolve));
  studio.db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created,platform_id) VALUES(?,?,?,?,?,?,?)').run(account.id,'bilibili','专栏受控账号','browser','connected',new Date().toISOString(),account.platform_id);
  const template=studio.agentTools.execute('save_template',{enabled:true,spec:{topic:'B站专栏',style:'简洁',facts:'给定事实',targets:[{accountId:account.id,type:'article'}],assetIds:[],mode:'auto',maxCalls:1}});
  const run=studio.agentTools.execute('run_template',{id:template.id,requestKey:'bili-article'});let job;
  for(let i=0;i<300;i++){job=studio.db.prepare('SELECT * FROM jobs WHERE account_id=?').get(account.id);if(job&&['submitted','needs_manual','unknown'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(job?.state,'submitted');assert.equal(await page.evaluate(()=>window.submits),1);
  assert.equal(studio.db.prepare('SELECT COUNT(*) AS n FROM publication_attempts WHERE job_id=?').get(job.id).n,1);
  assert.equal(studio.agentTools.execute('run',{id:run.id}).targets[0].job.id,job.id);
});
