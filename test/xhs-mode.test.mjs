import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {xhsMode,xhsUpload} from '../xhs-publisher.mjs';

async function pageFor(t,html){
  const browser=await chromium.launch({channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(2000);await page.setContent(html);return page;
}
const rule={upload:'input[type="file"][accept*="image"],input[type="file"][accept*=".jpg"]',modeTimeoutMs:2000,uploadTimeoutMs:2000};

test('小红书实际creator-tab形态：异步挂载、同名离屏及透明副本只点击可命中的图文标签',async t=>{
  const page=await pageFor(t,`<style>.creator-tab{display:inline-block;padding:20px}.offscreen{position:absolute;left:-9999px}.transparent{opacity:0}</style>
  <div id="tabs"></div><input id="file" type="file" accept=".mp4,.mov" style="display:none"><script>
  window.clicks=0;setTimeout(()=>{document.querySelector('#tabs').innerHTML='<div class="creator-tab active"><span class="title">上传视频</span></div><div class="creator-tab" id="actual"><span class="title">上传图文</span></div><div class="creator-tab offscreen"><span class="title">上传图文</span></div><div class="creator-tab transparent"><span class="title">上传图文</span></div>';document.querySelector('#actual').onclick=()=>{window.clicks++;document.querySelector('#file').accept='.jpg,.png';};document.querySelectorAll('.offscreen,.transparent').forEach(n=>n.onclick=()=>window.wrong=true);},200);
  </script>`);
  await xhsMode(page,'note',rule);const input=await xhsUpload(page,'note',rule);
  assert.equal(await input.getAttribute('id'),'file');assert.equal(await page.evaluate(()=>window.clicks),1);assert.equal(await page.evaluate(()=>window.wrong),undefined);
});

test('小红书入口重叠副本不造成歧义，点击命中真实在上层的标签',async t=>{
  const page=await pageFor(t,`<style>.creator-tab{position:absolute;left:20px;top:20px;padding:20px;background:white}</style><div class="creator-tab" onclick="window.wrong=true"><span>上传图文</span></div><div class="creator-tab" onclick="window.correct=true;document.querySelector('input').accept='image/*'"><span>上传图文</span></div><input type="file" accept="video/*" style="display:none">`);
  await xhsMode(page,'note',rule);await xhsUpload(page,'note',rule);
  assert.equal(await page.evaluate(()=>window.correct),true);assert.equal(await page.evaluate(()=>window.wrong),undefined);
});

test('小红书确有两个可操作入口时不任取第一个，不执行任何点击',async t=>{
  const page=await pageFor(t,'<button role="tab" onclick="window.clicked=true">上传图文</button><button role="tab" onclick="window.clicked=true">上传图文</button>');
  await assert.rejects(xhsMode(page,'note',{...rule,modeTimeoutMs:200}),/多个可操作/);assert.equal(await page.evaluate(()=>window.clicked),undefined);
});

test('小红书切换后等待异步图片控件，排除隐藏非活动面板中的上传框',async t=>{
  const page=await pageFor(t,`<button role="tab" onclick="setTimeout(()=>document.querySelector('#active').innerHTML='<input id=correct type=file accept=image/* style=display:none>',250)">上传图文</button><section hidden><input id="inactive" type="file" accept="image/*"></section><section id="active"></section>`);
  await xhsMode(page,'note',rule);const input=await xhsUpload(page,'note',rule);assert.equal(await input.getAttribute('id'),'correct');
});

test('小红书直接进入图文上传面板且无标签时仍可上传',async t=>{
  const page=await pageFor(t,'<section><input type="file" id="direct" accept=".jpeg,.png,.webp" style="display:none"></section>');
  await xhsMode(page,'note',rule);assert.equal(await (await xhsUpload(page,'note',rule)).getAttribute('id'),'direct');
});
