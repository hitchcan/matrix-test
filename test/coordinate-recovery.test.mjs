import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {observeVisualRecovery} from '../workflow/visual-recovery.mjs';
import {preparationGoal,validVisualAction} from '../workflow/coordinate-recovery.mjs';
import {douyinVisibility} from '../douyin-visibility.mjs';

const hosts=['creator.douyin.com'];
const editor={platform:'douyin',url:'https://creator.douyin.com/creator-micro/content/upload',coordinateGoal:{kind:'visibility',desired:'仅自己可见'}};
async function setup(t,html){const b=await chromium.launch({channel:'chrome',headless:true});t.after(()=>b.close());const c=await b.newContext({viewport:{width:900,height:700}});await c.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));const page=await c.newPage();await page.goto('https://creator.douyin.com/creator-micro/content/post/video');return {page,context:c};}
const point=async(page,selector)=>{const r=await page.locator(selector).boundingBox();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};};
const click=(snapshot,p)=>({action:'click_at',token:snapshot.observation.token,goal:'visibility',...p});

test('任务缺口只能来自可信阶段和快照，坐标参数严格校验',()=>{
  assert.deepEqual(preparationGoal({publication:{douyinVisibility:'private'}},'douyin','设置抖音视频可见范围'),editor.coordinateGoal);
  assert.equal(preparationGoal({publication:{douyinVisibility:'private'}},'douyin','上传素材'),null);
  assert.equal(preparationGoal({publication:{douyinVisibility:'private'}},'xhs','设置抖音视频可见范围'),null);
  const o={coordinateMode:true,goal:editor.coordinateGoal,actions:['click_at'],token:'x',viewport:{width:100,height:100}};
  assert.ok(validVisualAction({action:'click_at',token:'x',goal:'visibility',x:5,y:8},o));
  for(const change of [{goal:'payment'},{x:-1},{x:100},{x:NaN},{y:1.2},{targetId:'v0'},{script:'publish()'}])assert.equal(validVisualAction({action:'click_at',token:'x',goal:'visibility',x:5,y:8,...change},o),false);
});

test('真实抖音设置行：模型任意选择标签内部坐标，标准适配器独立读回，未操作好友或发布',async t=>{
  const fixture=readFileSync(new URL('./fixtures/douyin-saved-visibility.html',import.meta.url),'utf8');
  const {page}=await setup(t,`<p>private-account-secret</p><textarea>private-draft-secret</textarea>${fixture}<button id="publish" onclick="window.sent=true">发布</button><style>label{display:inline-block;padding:12px}input{width:0;opacity:0;position:absolute}</style><script>document.addEventListener('click',e=>{const l=e.target.closest('label');if(!l)return;e.preventDefault();const v=l.querySelector('input').value;document.querySelectorAll('label').forEach(n=>{const i=n.querySelector('input');i.checked=i.value===v;n.dataset.checked=String(i.checked);});});</script>`);
  const snapshot=await observeVisualRecovery(page,hosts,editor);assert.equal(snapshot.observation.coordinateMode,true);assert.deepEqual(snapshot.observation.targets,[]);assert.ok(!JSON.stringify({...snapshot.observation,screenshot:null}).includes('secret'));
  const p=await point(page,'label:has(input[value="1"])');p.x+=7;
  assert.equal(await snapshot.perform(click(snapshot,p)),true);assert.equal(await snapshot.perform(click(snapshot,p)),false);await snapshot.dispose();
  assert.equal((await douyinVisibility(page,'private',{}, {verifyOnly:true})).value,'private');assert.equal(await page.locator('input[value="2"]').isChecked(),false);assert.equal(await page.evaluate(()=>!!window.sent),false);
});

test('未知展开控件及无ARIA弹出菜单：跨观察探索后只能选择任务目标值',async t=>{
  const {page}=await setup(t,`<section><span>谁可以看</span><button id="custom" type="button" aria-haspopup="listbox" onclick="document.querySelector('#portal').hidden=false">打开选择面板</button><span id="current">公开</span></section><div id="portal" hidden><div id="friends" onclick="window.wrong=true">好友可见</div><div id="private" onclick="document.querySelector('#current').textContent='仅自己可见';document.querySelector('#portal').hidden=true">仅自己可见</div></div>`);
  let s=await observeVisualRecovery(page,hosts,editor);assert.equal(await s.perform(click(s,await point(page,'#custom'))),true);await s.dispose();
  s=await observeVisualRecovery(page,hosts,editor);assert.equal(await s.perform(click(s,await point(page,'#friends'))),false);await s.dispose();
  s=await observeVisualRecovery(page,hosts,editor);assert.equal(await s.perform(click(s,await point(page,'#private'))),true);await s.dispose();
  assert.equal(await page.locator('#current').textContent(),'仅自己可见');assert.equal(await page.evaluate(()=>!!window.wrong),false);
});

test('坐标拒绝最终提交、错误目标、账号导航、画布、遮挡及过期页面',async t=>{
  const {page}=await setup(t,`<section><span>谁可以看</span><button id="publish" type="button" onclick="window.sent=true">确认发布</button><label id="public"><input type="checkbox" checked>公开</label><label id="private"><input type="checkbox">仅自己可见</label><canvas width="50" height="50"></canvas></section><nav><button id="account">仅自己可见</button></nav>`);
  for(const selector of ['#publish','#public','#account','canvas']){const s=await observeVisualRecovery(page,hosts,editor);assert.equal(await s.perform(click(s,await point(page,selector))),false);await s.dispose();}
  let s=await observeVisualRecovery(page,hosts,editor),p=await point(page,'#private');await page.locator('#private').evaluate(n=>n.style.transform='translateX(200px)');assert.equal(await s.perform(click(s,p)),false);await s.dispose();
  s=await observeVisualRecovery(page,hosts,editor);p=await point(page,'#private');await page.evaluate(()=>{const n=document.createElement('div');n.style='position:fixed;inset:0;z-index:999';document.body.append(n);});assert.equal(await s.perform(click(s,p)),false);await s.dispose();
  assert.equal(await page.evaluate(()=>!!window.sent),false);assert.deepEqual(await observeVisualRecovery(page,['other.example'],editor),{human:true});
});

test('坐标阶段阻断网络副作用、弹窗和跨页；验证码出现不截图',async t=>{
  const {page,context}=await setup(t,`<section><span>谁可以看</span><button id="open" type="button" aria-expanded="false" onclick="fetch('/publish',{method:'POST'}).catch(()=>{});fetch('/publish-get').catch(()=>{});window.open('https://other.example');this.setAttribute('aria-expanded','true')">展开选择器</button></section>`);
  let writes=0;await context.route('**/publish*',r=>{writes++;return r.fulfill({body:'ok'});});
  let s=await observeVisualRecovery(page,hosts,editor);assert.equal(await s.perform(click(s,await point(page,'#open'))),true);for(let i=0;i<40&&context.pages().length>1;i++)await page.waitForTimeout(50);assert.equal(writes,0);assert.equal(context.pages().length,1);await s.dispose();
  await page.setContent('<input autocomplete="one-time-code">');let screenshots=0;const original=page.screenshot.bind(page);page.screenshot=(...args)=>{screenshots++;return original(...args);};
  assert.deepEqual(await observeVisualRecovery(page,hosts,editor),{human:true});assert.equal(screenshots,0);
});
