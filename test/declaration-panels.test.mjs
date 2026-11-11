import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
import {applyDeclarationAi} from '../zhihu-ai.mjs';
import {fileURLToPath} from 'node:url';

async function setup(t,platform,{broken=false}={}){
 const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1280,height:800}});
 const xhs=platform==='xhs',label=xhs?'添加内容类型声明':'无声明',ai=xhs?'笔记含AI合成内容':'包含 AI 辅助创作 作者对内容负责';
 const html=`<!doctype html><meta charset="utf-8"><style>.Select-button{display:inline-block;padding:12px;cursor:pointer}footer{position:fixed;bottom:0;right:0;background:white}#menu{position:fixed;top:200px;left:300px;background:white;padding:20px;z-index:100}</style>
 ${xhs?'<div class="creator-tab active">上传图文</div><input type="file" accept="image/*" style="display:none">':''}
 <input placeholder="填写标题"><textarea placeholder="请输入标题" ${xhs?'hidden':''}></textarea><div class="${xhs?'tiptap ProseMirror':'public-DraftEditor-content'}" contenteditable="true"></div>
 <section id="settings" style="margin-top:1000px"><h2>${xhs?'内容设置':'发布设置'}</h2>${xhs?'':'<div>添加封面</div><div>投稿至问题</div>'}<div>${xhs?'':'<label>创作声明<span>？</span></label>'}<div class="Select-button" id="trigger" onclick="openMenu()"><span>${label}</span></div></div><div>文章话题</div></section>
 <footer><button id="final" onclick="window.posts++;${xhs?"document.querySelector('#done').hidden=false":"history.replaceState({},'','/p/998877')"}">发布</button></footer><div hidden id="done">发布成功</div>
 <script>window.posts=0;window.opens=0;const ai=${JSON.stringify(ai)},empty=${JSON.stringify(label)};
 function pick(text){${broken?'return;':"document.querySelector('#trigger').outerHTML='<div class=\"Select-button\" id=\"trigger\" onclick=\"openMenu()\"><span>'+text+'</span></div>';document.querySelector('#menu').remove();"}}
 function openMenu(){window.opens++;if(document.querySelector('#menu'))return;const menu=document.createElement('div');menu.id='menu';menu.setAttribute('role','listbox');for(const text of ${xhs?'["虚构演绎，仅供娱乐",ai,"内容包含营销广告"]':'["包含剧透","包含医疗建议",ai,"无声明"]'}){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=text;const selected=document.querySelector('#trigger').textContent.trim()===text;option.setAttribute('aria-selected',String(selected));option.onclick=()=>pick(${xhs?'selected?empty:text':'text'});menu.append(option);}document.body.append(menu);}
 </script>`;
 await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));const page=await context.newPage();page.setDefaultTimeout(5000);
 const runtime={setMode:async()=>{},check:async()=>({platformId:'self'}),open:async()=>({page})};const adapter=new PublishAdapter(runtime,loadAdapterRules(fileURLToPath(new URL('..',import.meta.url))),()=>null);
 const account={platform,id:'fixture',platform_id:'self',status:'connected'},content={type:xhs?'note':'article',title:'截图控件回归',body:'测试正文',assetIds:[],publication:{mode:'auto',aiAssisted:true}};
 return {page,adapter,account,content,ai};
}
for(const platform of ['xhs','zhihu'])test('截图中的'+platform+'声明：滚动、平台原文、React替换、取消和最终提交前复核',async t=>{
 const {page,adapter,account,content,ai}=await setup(t,platform);
 const prepared=await adapter.prepare(account,content);assert.equal(prepared.aiDisclosure.checked,true);assert.equal(await page.locator('#trigger').innerText(),ai);
 assert.equal(await page.evaluate(()=>window.posts),0,'准备阶段不得点击固定底部发布按钮');
 const no={...content,publication:{...content.publication,aiAssisted:false}};
 const result=platform==='xhs'?await applyDeclarationAi(page,false,{timeout:500,labelNames:['添加内容类型声明']}):await adapter.applyAiDisclosure(page,prepared.rule,no);
 assert.equal(result.checked,false);assert.equal(await page.locator('#trigger').innerText(),platform==='xhs'?'添加内容类型声明':'无声明');
 let clicked=false;const receipt=await adapter.submit(account,content,()=>clicked=true);assert.equal(clicked,true);assert.equal(receipt.aiDisclosure.checked,true);assert.equal(await page.evaluate(()=>window.posts),1);
});

test('截图形式菜单点击后不回显时不提交；正文中的AI字样不作为选择证据',async t=>{
 const {page,adapter,account,content}=await setup(t,'xhs',{broken:true});await page.goto(adapter.rule(account,content).url);
 await page.locator('[contenteditable]').fill('笔记含AI合成内容');
 await assert.rejects(applyDeclarationAi(page,true,{timeout:300,labelNames:['添加内容类型声明']}),/未能从当前选项读回一致状态/);
 assert.equal(await page.evaluate(()=>window.posts),0);
});
