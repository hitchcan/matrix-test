import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {xhsPublishButton} from '../xhs-publisher.mjs';
import {douyinAi} from '../douyin-publisher.mjs';
import {bilibiliAi,bilibiliDiskFiles,bilibiliUpload} from '../bilibili-publisher.mjs';
import {PublishAdapter,loadAdapterRules} from '../browser-runtime.mjs';
const fixture=name=>readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8');
async function setup(t){const b=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>b.close());const p=await b.newPage();p.setDefaultTimeout(5000);return p;}
async function closedPage(t,disabled=false){
 const p=await setup(t);let html=fixture('xhs-saved-publish.html').replace('class="ce-btn bg-red"','class="ce-btn bg-red" onclick="window.posts++"');if(disabled)html=html.replace('submit-disabled="false"','submit-disabled="true"');
 await p.setContent(html);await p.evaluate(()=>{window.posts=0;const h=document.querySelector('xhs-publish-btn'),t=h.querySelector('template');if(t){h.attachShadow({mode:'closed'}).append(t.content);t.remove();}});return p;
}

test('B站磁盘上传保留扩展名和内容，缓存路径限制在素材目录内',t=>{
 const dir=mkdtempSync(join(tmpdir(),'matrix-saved-bili-'));t.after(()=>{const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('matrix-saved-bili-'))throw Error('测试目录无效');rmSync(target,{recursive:true,force:true});});
 const source=join(dir,'asset-without-extension');writeFileSync(source,'fixture video bytes');
 const asset={path:source,name:'..\\..\\video.mp4'};
 const [file]=bilibiliDiskFiles([asset]);assert.equal(basename(file),'video.mp4');assert.equal(dirname(dirname(file)),join(dir,'.browser-upload'));assert.equal(readFileSync(file,'utf8'),'fixture video bytes');assert.equal(readFileSync(source,'utf8'),'fixture video bytes');assert.equal(bilibiliDiskFiles([asset])[0],file);
 assert.throws(()=>bilibiliDiskFiles([{path:source,name:'video.txt'}]),/扩展名/);
});

test('B站先出现备用buploader时等待官方入口，不绕过任务初始化',async t=>{
 const p=await setup(t);await p.setContent('<input name="buploader" type="file" accept=".mp4">');
 await p.evaluate(()=>{
  window.pickerOpens=0;setTimeout(()=>{const root=document.createElement('div');root.className='bcc-upload-wrapper';root.innerHTML='<button class="upload-area">上传视频</button><input id="official-file" type="file" accept=".mp4" hidden>';root.querySelector('button').onclick=()=>{window.pickerOpens++;root.querySelector('input').click();};document.body.append(root);},250);
 });
 const upload=await bilibiliUpload(p,{upload:'.bcc-upload-wrapper input[type="file"]'});await upload.setInputFiles([{name:'video.mp4',mimeType:'video/mp4',buffer:Buffer.from('fixture')}]);
 assert.equal(await p.evaluate(()=>window.pickerOpens),1);assert.equal(await p.locator('input[name="buploader"]').evaluate(n=>n.files.length),0);assert.equal(await p.locator('#official-file').evaluate(n=>n.files[0].name),'video.mp4');
});

for(const platform of ['douyin','bilibili'])test(platform+' 不勾选AI：准备及提交复核不打开默认声明，不要求声明控件存在',async t=>{
 const p=await setup(t);await p.setContent(fixture(platform==='douyin'?'douyin-saved-declaration.html':'bilibili-saved-video.html'));
 if(platform==='bilibili')await p.locator('input[placeholder*="创作声明"]').evaluate(n=>n.value='内容无需标注');
 await p.evaluate(()=>{window.clicks=0;document.addEventListener('click',()=>window.clicks++);});
 const apply=()=>platform==='douyin'?douyinAi(p,false,{}):bilibiliAi(p,false);
 assert.equal((await apply()).checked,false);assert.equal((await apply()).checked,false);assert.equal(await p.evaluate(()=>window.clicks),0);
 await p.setContent('<button>高级设置</button><p>没有声明控件的编辑器</p>');
 await p.evaluate(()=>{window.clicks=0;document.addEventListener('click',()=>window.clicks++);});
 assert.equal((await apply()).state,'not_requested');assert.equal(await p.evaluate(()=>window.clicks),0);
});

test('B站不勾选AI：保留已有非AI声明，仅明确已选AI时取消并读回',async t=>{
 const p=await setup(t);await p.setContent(fixture('bilibili-saved-video.html'));
 await p.evaluate(()=>{
  window.clicks=0;document.querySelector('input[placeholder*="创作声明"]').value='内容为转载';
  document.querySelector('.bcc-select-input-wrap').onclick=()=>{window.clicks++;document.querySelector('.bcc-select-list-wrap').style.display='block';};
  document.querySelectorAll('.bcc-option').forEach(n=>n.onclick=()=>{document.querySelector('input[placeholder*="创作声明"]').value=n.textContent.trim();document.querySelector('.bcc-select-list-wrap').style.display='none';});
 });
 assert.equal((await bilibiliAi(p,false)).checked,false);assert.equal(await p.evaluate(()=>window.clicks),0);
 await p.locator('input[placeholder*="创作声明"]').evaluate(n=>n.value='含AI生成内容');
 assert.equal((await bilibiliAi(p,false)).checked,false);assert.equal(await p.locator('input[placeholder*="创作声明"]').inputValue(),'内容无需标注');assert.equal(await p.evaluate(()=>window.clicks),1);
 await bilibiliAi(p,false);assert.equal(await p.evaluate(()=>window.clicks),1);
 await p.locator('input[placeholder*="创作声明"]').evaluate(n=>n.value='');await bilibiliAi(p,false);assert.equal(await p.locator('input[placeholder*="创作声明"]').inputValue(),'内容无需标注');assert.equal(await p.evaluate(()=>window.clicks),2);
});
test('真实保存的小红书closed shadow组件：找到红色按钮并只点击一次',async t=>{
 const p=await closedPage(t);assert.equal(await p.getByRole('button',{name:'发布',exact:true}).count(),0);
 const b=await xhsPublishButton(p,{});assert.equal(await b.count(),1);assert.equal(await b.isEnabled(),true);assert.equal(await p.evaluate(()=>window.posts),0);await b.click();assert.equal(await p.evaluate(()=>window.posts),1);
});
test('小红书closed shadow按钮禁用、重复或被遮挡时阻断',async t=>{
 const p=await closedPage(t,true);await assert.rejects(xhsPublishButton(p,{readyTimeoutMs:100}),/不可用/);assert.equal(await p.evaluate(()=>window.posts),0);
 await p.locator('xhs-publish-btn').evaluate(n=>n.setAttribute('submit-disabled','false'));const button=await xhsPublishButton(p,{});
 await p.evaluate(()=>{const n=document.createElement('div');n.style='position:fixed;inset:0;background:white;z-index:999999';document.body.append(n);});await assert.rejects(button.click(),/遮挡/);assert.equal(await p.evaluate(()=>window.posts),0);
});
test('抖音保存的selectBox作为入口，文本不能接受点击；checkbox单选弹窗也必须确定',async t=>{
 const p=await setup(t);await p.setContent(fixture('douyin-saved-declaration.html')+'<style>[class*="selectText-"]{pointer-events:none}[class*="selectBox-"]{padding:20px}</style><div id="modal" hidden><h5><div><p>对作品内容添加声明</p><p>可在作品发布前添加声明，帮助他人减少困惑</p></div></h5><p>请选择声明类型（单选）</p><label><input type="checkbox" id="ai" style="opacity:0;position:absolute;pointer-events:none"><span>内容由AI生成</span></label><label><input type="checkbox" id="none" style="opacity:0;position:absolute;pointer-events:none"><span>无需添加自主声明</span></label><button id="confirm" disabled>确定</button><button>取消</button></div><button id="publish">发布</button>');
 await p.evaluate(()=>{
  window.confirms=0;window.posts=0;document.querySelector('[class*="selectBox-"]').onclick=()=>document.querySelector('#modal').hidden=false;
  document.querySelectorAll('#modal input').forEach(n=>n.onchange=()=>{document.querySelector('#confirm').disabled=false;window.choice=n.id;});
  document.querySelector('#confirm').onclick=()=>{window.confirms++;document.querySelector('[class*="selectText-"]').textContent=window.choice==='ai'?'内容由AI生成':'无需添加自主声明';document.querySelector('#modal').hidden=true;};
  document.querySelector('#publish').onclick=()=>window.posts++;
 });
 assert.equal((await douyinAi(p,true,{})).checked,true);assert.equal(await p.evaluate(()=>window.confirms),1);assert.equal(await p.evaluate(()=>window.posts),0);
 await p.locator('[class*="selectBox-"]').click();assert.equal((await douyinAi(p,false,{})).checked,false);assert.equal(await p.evaluate(()=>window.confirms),2);assert.equal(await p.evaluate(()=>window.posts),0);
});
test('B站真实保存视频页：扩展名上传框、独立简介、创作声明、span立即投稿与明确回执',async t=>{
 const p=await setup(t),dir=mkdtempSync(join(tmpdir(),'matrix-saved-bili-'));t.after(()=>{const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('matrix-saved-bili-'))throw Error('测试目录无效');rmSync(target,{recursive:true,force:true});});
 const video=join(dir,'sample.mp4');writeFileSync(video,'fixture');await p.context().route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture('bilibili-saved-video.html')}));
 const runtime={check:async()=>({platformId:'self'}),open:async()=>({page:p}),setMode:async()=>{}};
 const a={platform:'bilibili',platform_id:'self',status:'connected'},c={type:'video',title:'投稿测试',body:'只填写简介',assetIds:['video'],publication:{mode:'auto',aiAssisted:true}};
 const adapter=new PublishAdapter(runtime,loadAdapterRules(fileURLToPath(new URL('..',import.meta.url))),()=>({path:video,name:'sample.mp4',mime:'video/mp4'}));
 // Restore controlled interactions after each navigation without executing saved site scripts.
 await p.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
  window.posts=0;window.pickerOpens=0;document.querySelector('.upload-area').onclick=()=>{window.pickerOpens++;document.querySelector('.bcc-upload-wrapper input').click();};
  document.querySelector('.bcc-select-input-wrap').onclick=()=>document.querySelector('.bcc-select-list-wrap').style.display='block';
  document.querySelectorAll('.bcc-option').forEach(n=>n.onclick=()=>{document.querySelector('input[placeholder*="创作声明"]').value=n.textContent.trim();document.querySelector('.bcc-select-list-wrap').style.display='none';});
  document.querySelector('.submit-add').onclick=()=>{window.posts++;const n=document.createElement('p');n.textContent='稿件投递成功';document.body.append(n);};
 }));
 const prepared=await adapter.prepare(a,c);assert.equal(prepared.aiDisclosure.checked,true);
 assert.equal(await p.evaluate(()=>window.pickerOpens),1);
 assert.equal(await p.locator('.bcc-upload-wrapper input').evaluate(n=>n.files[0].name),'sample.mp4');assert.deepEqual(await p.locator('input[name="buploader"]').evaluateAll(ns=>ns.map(n=>n.files.length)),[0,0,0]);
 assert.equal(await p.locator('[editor_id="desc_at_editor"] .ql-editor').innerText(),c.body);assert.equal(await p.locator('[editor_id="dynamic_at_editor"] .ql-editor').innerText(),'');
 assert.equal(await p.evaluate(()=>window.posts),0);let clicked=false;const receipt=await adapter.submit(a,c,()=>clicked=true);assert.equal(clicked,true);assert.equal(receipt.id,null);assert.equal(await p.evaluate(()=>window.posts),1);
});
