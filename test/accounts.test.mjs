import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from '../server.mjs';
async function setup(t,runtime={open:async()=>{},check:async a=>({platformId:a.id}),disconnect:async()=>{},close:async()=>{}}){
 const dir=mkdtempSync(join(tmpdir(),'matrix-accounts-'));let studio,origin,token;
 async function start(){studio=createStudio({dataDir:dir,tickMs:60000,browserRuntime:runtime});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+studio.server.address().port;token=(await(await fetch(origin+'/api/state')).json()).token;}
 await start();t.after(async()=>{await studio.close();const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('matrix-accounts-'))throw Error('测试目录无效');rmSync(target,{recursive:true,force:true});});
 return {dir,get studio(){return studio;},get origin(){return origin;},async restart(){await studio.close();await start();},async state(){return (await fetch(origin+'/api/state')).json();},async request(path,method='POST',body,auth=true){const res=await fetch(origin+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(auth?{'X-Studio-Token':token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};}};
}
function task(app,accountId,state){
 const db=app.studio.db;db.prepare('INSERT OR IGNORE INTO dispatches VALUES(?,?,?,?)').run('dispatch','key',JSON.stringify({title:'保留历史',type:'article',body:'正文'}),new Date().toISOString());
 db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('job','dispatch',accountId,'zhihu','历史账号','browser',state,'normal',new Date().toISOString(),null);
}
test('删除账号校验令牌、关闭会话与清理指定环境，历史保留；删除后重启不复活演示账号',async t=>{
 const disconnected=[];const app=await setup(t,{disconnect:async id=>disconnected.push(id),close:async()=>{}});
 const {body:a}=await app.request('accounts','POST',{platform:'douyin',name:'测试抖音'});
 const profile=join(app.dir,'profiles',a.id),other=join(app.dir,'profiles','other');mkdirSync(profile,{recursive:true});mkdirSync(other,{recursive:true});writeFileSync(join(profile,'session'),'fixture');
 assert.equal((await app.request('accounts/'+a.id,'DELETE',undefined,false)).status,403);assert.equal(existsSync(profile),true);
 assert.equal((await app.request('accounts/'+a.id,'DELETE')).status,200);assert.deepEqual(disconnected,[a.id]);assert.equal(existsSync(profile),false);assert.equal(existsSync(other),true);
 assert.equal((await app.request('accounts/'+a.id,'DELETE')).status,404);
 task(app,'demo-zhihu','submitted');assert.equal((await app.request('accounts/demo-zhihu','DELETE')).status,200);
 assert.equal((await app.state()).jobs.length,1);assert.equal((await app.request('jobs/job/inspect','POST',{})).status,409);
 assert.equal((await app.request('accounts/demo-bilibili','DELETE')).status,200);await app.restart();assert.equal((await app.state()).accounts.length,0);assert.equal((await app.state()).jobs[0].account_name,'历史账号');
});
test('所有未结束任务均阻止账号删除，结束后允许删除',async t=>{
 const app=await setup(t);
 for(const state of ['queued','uploading','opening_settings','awaiting_confirmation','needs_verification','unknown','needs_manual','needs_login','identity_mismatch','blocked','submitting']){
  task(app,'demo-zhihu',state);const res=await app.request('accounts/demo-zhihu','DELETE');assert.equal(res.status,409,state);assert.match(res.body.error,/未结束任务/);
 }
 task(app,'demo-zhihu','cancelled');assert.equal((await app.request('accounts/demo-zhihu','DELETE')).status,200);
});
test('删除关闭浏览器期间拒绝新任务；关闭失败保留账号并可重试',async t=>{
 let started,finish;let broken=false;
 const began=new Promise(r=>started=r);const wait=new Promise(r=>finish=r);
 const app=await setup(t,{disconnect:async()=>{started();await wait;if(broken)throw Error('close failed');},close:async()=>{}});
 const {body:a}=await app.request('accounts','POST',{platform:'zhihu',name:'删除中'});app.studio.db.prepare("UPDATE accounts SET status='connected',platform_id='self' WHERE id=?").run(a.id);
 const deletion=app.request('accounts/'+a.id,'DELETE');await began;
 const dispatch=await app.request('dispatch','POST',{requestKey:'race',accountIds:[a.id],content:{type:'article',title:'删除竞争',body:'正文',assetIds:[],publication:{mode:'manual',aiAssisted:false}}});assert.equal(dispatch.status,422);assert.match(dispatch.body.issues.join(''),/正在删除/);
 broken=true;finish();assert.equal((await deletion).status,500);assert.ok((await app.state()).accounts.some(x=>x.id===a.id));broken=false;assert.equal((await app.request('accounts/'+a.id,'DELETE')).status,200);
});
test('页面四平台筛选、添加、跨平台选择、删除取消与引用提示',{timeout:60000},async t=>{
 const app=await setup(t);const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());const p=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(app.origin+'/#accounts');await p.locator('[data-account-platform="douyin"]').click();assert.equal(await p.locator('[data-account-card]').count(),0);assert.equal(await p.locator('#account-form [name="platform"]').inputValue(),'douyin');
 await p.locator('#account-form [name="name"]').fill('我的抖音');await p.locator('#account-form button').click();await p.getByRole('heading',{name:'我的抖音',exact:true}).waitFor();
 for(const platform of ['bilibili','zhihu','xhs']){await p.locator('[data-account-platform="'+platform+'"]').click();await p.locator('#account-form [name="name"]').fill('我的'+platform);await p.locator('#account-form button').click();await p.getByRole('heading',{name:'我的'+platform,exact:true}).waitFor();}
 await p.locator('[data-account-platform=""]').click();assert.equal(await p.locator('[data-account-card]').count(),6);
 await p.screenshot({path:join(tmpdir(),'matrix-accounts-preview.png'),fullPage:true});
 await p.goto(app.origin+'/#compose');await p.locator('#target-platform').selectOption('douyin');await p.getByRole('checkbox',{name:'选择 我的抖音',exact:true}).check();
 await p.locator('#target-platform').selectOption('xhs');await p.getByRole('checkbox',{name:'选择 我的xhs',exact:true}).check();await p.locator('#target-platform').selectOption('douyin');assert.equal(await p.getByRole('checkbox',{name:'选择 我的抖音',exact:true}).isChecked(),true);
 await p.getByRole('checkbox',{name:'选择 我的抖音',exact:true}).uncheck();await p.locator('#target-platform').selectOption('xhs');assert.equal(await p.getByRole('checkbox',{name:'选择 我的xhs',exact:true}).isChecked(),true);
 await p.goto(app.origin+'/#accounts');await p.locator('[data-account-platform="douyin"]').click();await p.locator('[data-delete-account]').click();await p.locator('#cancel-delete-account').click();assert.equal((await app.state()).accounts.length,6);
 await p.locator('[data-delete-account]').click();await p.locator('#confirm-delete-account').click();await p.locator('#detail').waitFor({state:'hidden'});assert.equal(await p.locator('[data-account-card]').count(),0);assert.equal((await app.state()).accounts.length,5);
 await p.locator('[data-account-platform="zhihu"]').click();task(app,'demo-zhihu','unknown');await p.locator('[data-account-card="demo-zhihu"] [data-delete-account]').click();await p.locator('#confirm-delete-account').click();await p.locator('#account-delete-error').getByText(/未结束任务/).waitFor();assert.equal((await app.state()).accounts.length,5);assert.deepEqual(errors,[]);
});

test('添加后自动打开四平台后台，未扫码账号仍可删除；旧服务显示重启提示',{timeout:60000},async t=>{
 const opened=[];const app=await setup(t,{open:async a=>opened.push(a.platform),disconnect:async()=>{},close:async()=>{}});
 const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());const p=await browser.newPage();
 await p.goto(app.origin+'/#accounts');
 for(const platform of ['douyin','bilibili','zhihu','xhs']){
  await p.locator('[data-account-platform="'+platform+'"]').click();await p.locator('#account-form [name="name"]').fill('未扫码'+platform);
  const done=p.waitForResponse(r=>r.url().endsWith('/open')&&r.request().method()==='POST');
  await p.locator('#account-form button').click();assert.equal((await done).status(),200);
  await p.waitForFunction(()=>!document.querySelector('#account-form button').disabled);
  const state=await app.state(),account=state.accounts.find(a=>a.name==='未扫码'+platform);assert.equal(account.platform_id,null);
  await p.locator('[data-account-card="'+account.id+'"] [data-delete-account]').click();await p.locator('#confirm-delete-account').click();await p.locator('#detail').waitFor({state:'hidden'});
  assert.equal((await app.state()).accounts.some(a=>a.id===account.id),false);
 }
 assert.deepEqual(opened,['douyin','bilibili','zhihu','xhs']);
 await p.route('**/api/state',async route=>{const r=await route.fetch(),body=await r.json();delete body.capabilities;await route.fulfill({response:r,json:body});});
 await p.reload();await p.locator('#service-update').waitFor({state:'visible'});assert.match(await p.locator('#service-update').innerText(),/重启|重新|Ctrl\+C/);
 await p.locator('[data-account-platform=""]').click();assert.equal(await p.locator('[data-delete-account]:not([disabled])').count(),0);
});
