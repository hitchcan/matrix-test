import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {watchKuaishouSubmission,kuaishouReceipt} from '../kuaishou-publisher.mjs';
import {channelsHomeIdentity} from '../wechat-channels.mjs';
test('快手只接受本次官方POST成功响应，提前捕获的回执不依赖toast',async()=>{
  let listener,removed=false;
  const page={on:(name,fn)=>listener=fn,off:()=>removed=true};const capture=watchKuaishouSubmission(page);
  const respond=(result,url='https://cp.kuaishou.com/rest/cp/works/v2/video/pc/submit',method='POST')=>listener({url:()=>url,status:()=>200,request:()=>({method:()=>method}),json:async()=>({result})});
  await respond(1,'https://evil.test/rest/cp/works/v2/video/pc/submit');assert.equal(capture.accepted(),false);
  await respond(1,undefined,'GET');assert.equal(capture.accepted(),false);await respond(0);assert.equal(capture.accepted(),false);
  await respond(1);const receipt=await kuaishouReceipt(page,{resultTimeoutMs:50},capture);assert.match(receipt.evidence,/接受投稿/);assert.equal(receipt.id,null);capture.close();assert.equal(removed,true);
});
test('快手在click返回前显示又消失的成功提示仍能捕获',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><p id="toast" hidden>视频发布成功，正在审核</p>'}));await page.goto('https://cp.kuaishou.com/article/publish/video');
  const capture=watchKuaishouSubmission(page);t.after(()=>capture.close());await page.locator('#toast').evaluate(n=>n.hidden=false);await page.waitForTimeout(250);await page.locator('#toast').evaluate(n=>n.hidden=true);
  const receipt=await kuaishouReceipt(page,{resultTimeoutMs:50},capture);assert.match(receipt.evidence,/页面显示发布成功/);
});
test('快手接受 /pc/publish 系列成功响应（含 refresh 子路径）',async()=>{
  let listener;
  const page={on:(name,fn)=>listener=fn,off:()=>{},url:()=>'https://cp.kuaishou.com/article/publish/video'};
  const respond=(json,path)=>listener({url:()=>'https://cp.kuaishou.com'+path,status:()=>200,request:()=>({method:()=>'POST'}),json:async()=>json});
  const capture=watchKuaishouSubmission(page);
  await respond({result:0},'/rest/cp/works/v2/video/pc/publish/refresh');
  assert.equal(capture.accepted(),false);
  await respond({result:1},'/rest/cp/works/v2/video/pc/publish/refresh');
  assert.equal(capture.accepted(),true);
  assert.match(capture.path(),/\/pc\/publish/);
  const receipt=await kuaishouReceipt(page,{resultTimeoutMs:50},capture);
  assert.match(receipt.evidence,/publish\/refresh/);
  capture.close();
});
test('视频号首页ID：仅读取明确的本人ID控件，昵称或不一致复制值不接受',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<wujie-app><template shadowrootmode="open"><div class="finder-uniq-id-wrap"><span class="finder-uniq-id" id="finder-uid-copy" data-clipboard-text="sphFixture123">sphFixture123</span></div></template></wujie-app>'}));
  await page.goto('https://channels.weixin.qq.com/platform');assert.equal((await channelsHomeIdentity(page)).platformId,'sphFixture123');
  await page.locator('#finder-uid-copy').evaluate(n=>n.setAttribute('data-clipboard-text','different'));assert.equal(await channelsHomeIdentity(page),null);
});
