import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {xhsPublishButton} from '../xhs-publisher.mjs';
import {douyinAi} from '../douyin-publisher.mjs';
import {bilibiliIdentity} from '../bilibili-identity.mjs';
async function pageFor(t){const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(2000);return page;}

test('小红书最终按钮与侧栏发布笔记区分；准备定位不会点击任何按钮',async t=>{
 const page=await pageFor(t);await page.setContent('<aside><button onclick="window.nav=true">发布笔记</button></aside><footer><button>暂存离开</button><button id="final" style="background:red" onclick="window.post=true">发布</button></footer>');
 assert.equal(await (await xhsPublishButton(page,{})).getAttribute('id'),'final');assert.equal(await page.evaluate(()=>window.post||window.nav),undefined);
 await page.locator('#final').evaluate(n=>n.remove());await assert.rejects(xhsPublishButton(page,{}),/未找到唯一的编辑器最终发布按钮/);assert.equal(await page.evaluate(()=>window.nav),undefined);
});
test('小红书两个精确发布按钮只接受明确的最终操作栏；真正两个操作栏仍阻断',async t=>{
 const page=await pageFor(t);await page.setContent('<div><button>发布</button></div><footer><button>暂存离开</button><button id="final">发布</button></footer>');assert.equal(await (await xhsPublishButton(page,{})).getAttribute('id'),'final');
 await page.locator('footer').evaluate(n=>n.parentElement.append(n.cloneNode(true)));await assert.rejects(xhsPublishButton(page,{}),/未找到唯一/);
});

const dialogHtml=broken=>`<div><label>自主声明</label><div id="trigger" onclick="document.querySelector('#modal').hidden=false">请选择自主声明</div></div><div contenteditable="true">内容由AI生成</div><button onclick="window.posts++">发布</button>
<div id="modal" hidden><h2>对作品内容添加声明</h2><p>请选择声明类型（单选）</p><label><input type="radio" name="decl" value="ai" onchange="selected(this)"><span>内容由AI生成</span></label><label><input type="radio" name="decl" value="other" onchange="selected(this)"><span>内容为个人观点或见解</span></label><label><input type="radio" name="decl" value="none" onchange="selected(this)"><span>无需添加自主声明</span></label><button onclick="window.cancelled=true">取消</button><button id="confirm" disabled onclick="confirmDecl()">确定</button></div><script>window.posts=0;window.confirms=0;function selected(n){window.value=n.value;document.querySelector('#confirm').disabled=false;}function confirmDecl(){window.confirms++;${broken?'':'document.querySelector("#trigger").textContent=window.value==="ai"?"内容由AI生成":"无需添加自主声明";'}document.querySelector('#modal').hidden=true;}</script>`;
test('抖音截图中的无dialog角色弹窗：单选AI、确定、读回；取消AI选无需声明',async t=>{
 const page=await pageFor(t);await page.setContent(dialogHtml(false));
 assert.equal((await douyinAi(page,true,{})).checked,true);assert.equal(await page.locator('#trigger').innerText(),'内容由AI生成');assert.equal(await page.evaluate(()=>window.confirms),1);assert.equal(await page.evaluate(()=>window.posts),0);
 assert.equal((await douyinAi(page,false,{})).checked,false);assert.equal(await page.locator('#trigger').innerText(),'无需添加自主声明');assert.equal(await page.evaluate(()=>window.posts),0);
});
test('抖音弹窗已经打开时不关闭重开；确认后无回显时保持未提交',async t=>{
 const page=await pageFor(t);await page.setContent(dialogHtml(false));await page.locator('#trigger').click();assert.equal((await douyinAi(page,true,{})).checked,true);assert.equal(await page.evaluate(()=>window.cancelled),undefined);
 await page.setContent(dialogHtml(true));await assert.rejects(douyinAi(page,true,{}),/未读回/);assert.equal(await page.evaluate(()=>window.posts),0);
});
test('B站身份必须同时具备成功、已登录和合法MID，不接受其他用户资料或Cookie存在',()=>{
 assert.equal(bilibiliIdentity({code:0,data:{isLogin:true,mid:123456,uname:'本人'}}).platformId,'123456');
 for(const json of [{code:0,data:{mid:123}},{code:-101,data:{isLogin:false,mid:123}},{code:0,data:{isLogin:false,mid:123}},{code:0,data:{isLogin:true,mid:0}},{code:0,data:{isLogin:true,mid:'invalid'}}])assert.equal(bilibiliIdentity(json),null);
});

for(const alreadyClosing of [false,true])test('抖音声明回显先更新、弹窗延迟关闭，重复复核不重选或二次确定：'+alreadyClosing,async t=>{
 const page=await pageFor(t);await page.setContent(dialogHtml(false));
 await page.evaluate(already=>{window.changes=0;document.querySelectorAll('input[type=radio]').forEach(n=>n.addEventListener('change',()=>window.changes++));document.querySelector('#confirm').onclick=()=>{window.confirms++;document.querySelector('#trigger').textContent='内容由AI生成';document.querySelector('#confirm').disabled=true;setTimeout(()=>document.querySelector('#modal').hidden=true,350);};if(already){document.querySelector('#trigger').textContent='内容由AI生成';document.querySelector('input[value=ai]').checked=true;document.querySelector('#modal').hidden=false;setTimeout(()=>document.querySelector('#modal').hidden=true,350);}},alreadyClosing);
 const first=await douyinAi(page,true,{});assert.equal(first.checked,true);assert.equal(await page.locator('#modal').isVisible(),false);assert.equal((await douyinAi(page,true,{})).checked,true);assert.equal(await page.evaluate(()=>window.confirms),alreadyClosing?0:1);assert.equal(await page.evaluate(()=>window.changes),alreadyClosing?0:1);assert.equal(await page.evaluate(()=>window.posts),0);
});
