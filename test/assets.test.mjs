import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from '../server.mjs';
import {archiveDay,validArchiveDay,referencesAsset} from '../asset-library.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lHsAAAAASUVORK5CYII=','base64');
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'matrix-assets-'));let studio,origin,token;
 async function start(){studio=createStudio({dataDir:dir,tickMs:60000});await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+studio.server.address().port;token=(await(await fetch(origin+'/api/state')).json()).token;}
 await start();t.after(async()=>{await studio.close();const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('matrix-assets-'))throw Error('测试目录无效');rmSync(target,{recursive:true,force:true});});
 return {dir,get studio(){return studio;},get origin(){return origin;},async restart(){await studio.close();await start();},async state(){return (await fetch(origin+'/api/state')).json();},async request(path,method='POST',body,auth=true){const res=await fetch(origin+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(auth?{'X-Studio-Token':token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};},async upload(day){const r=await fetch(origin+'/api/assets',{method:'POST',headers:{'Content-Type':'image/png','X-Studio-Token':token,'X-File-Name':encodeURIComponent('测试.png'),...(day?{'X-Archive-Date':day}:{})},body:png});return {status:r.status,...await r.json()};}};
}
test('日期验证与香港时区边界、封面和富文本引用识别',()=>{
 assert.equal(archiveDay('2026-11-10T17:00:00Z'),'2026-11-11');
 for(const day of ['2026-02-30','2026-2-01','0000-01-01','bad'])assert.equal(validArchiveDay(day),false);
 assert.equal(validArchiveDay('2024-02-29'),true);
 assert.equal(referencesAsset({versions:{zhihu:{bodyHtml:'<img src="/media/test-id">'}}},'test-id'),true);
 assert.equal(referencesAsset({coverAssetId:'test-id'},'test-id'),true);
 assert.equal(referencesAsset({bodyHtml:'<img src="/media/test-id-other">'},'test-id'),false);
});
test('上传、改名改日期、重启持久化、旧素材兼容和永久删除',async t=>{
 const app=await setup(t);assert.equal((await app.upload('2026-02-30')).status,400);
 const asset=await app.upload('2026-10-01');assert.equal(asset.status,201);
 assert.equal((await app.request('assets/'+asset.id,'POST',{name:'改名.png',archiveDate:'2026-09-30'})).status,200);
 assert.equal((await app.request('assets/'+asset.id,'POST',{name:'错误.mp4'})).status,400);
 assert.equal((await app.request('assets/'+asset.id,'POST',{archiveDate:'2026-02-29'})).status,400);
 app.studio.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run('legacy','旧图.png','image/png',1,'2026-10-01T17:00:00Z');
 await app.restart();let state=await app.state();assert.equal(state.assets.find(a=>a.id==='legacy').archiveDate,'2026-10-02');assert.equal(state.assets.find(a=>a.id===asset.id).archiveDate,'2026-09-30');assert.equal(state.assets.find(a=>a.id===asset.id).name,'改名.png');
 const cache=join(app.dir,'assets','.browser-upload',asset.id);mkdirSync(cache,{recursive:true});writeFileSync(join(cache,'改名.png'),png);
 assert.equal((await app.request('assets/'+asset.id,'DELETE',undefined,false)).status,403);
 assert.equal((await app.request('assets/'+asset.id,'DELETE')).status,200);assert.equal(existsSync(join(app.dir,'assets',asset.id)),false);assert.equal(existsSync(cache),false);assert.equal((await fetch(app.origin+'/media/'+asset.id)).status,404);
 assert.equal((await app.request('assets/'+asset.id,'DELETE')).status,404);
});
test('草稿正文、平台版本、封面及未结束任务引用阻止误删',async t=>{
 const app=await setup(t),asset=await app.upload();
 for(const content of [{assetIds:[asset.id]},{coverAssetId:asset.id},{versions:{zhihu:{bodyHtml:'<img src="/media/'+asset.id+'">'}}}]){
  app.studio.db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?)').run('draft',JSON.stringify(content),new Date().toISOString());
  assert.equal((await app.request('assets/'+asset.id,'DELETE')).status,409);
 }
 app.studio.db.prepare('DELETE FROM drafts').run();
 app.studio.db.prepare('INSERT INTO dispatches VALUES(?,?,?,?)').run('dispatch','key',JSON.stringify({assetIds:[asset.id]}),new Date().toISOString());
 app.studio.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('job','dispatch','demo-zhihu','zhihu','test','demo','needs_manual','normal',new Date().toISOString(),null);
 assert.equal((await app.request('assets/'+asset.id,'DELETE')).status,409);
 app.studio.db.prepare("UPDATE jobs SET state='cancelled'").run();assert.equal((await app.request('assets/'+asset.id,'DELETE')).status,200);
});
test('素材库页面：上传归档、组合筛选、编辑、取消与确认删除',{timeout:60000},async t=>{
 const app=await setup(t);const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());const p=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(app.origin+'/#assets');await p.locator('#library-upload-date').fill('2026-10-01');
 await p.locator('#library-upload').setInputFiles([{name:'秋日.png',mimeType:'image/png',buffer:png},{name:'风景.png',mimeType:'image/png',buffer:png}]);await p.locator('.asset-card').nth(1).waitFor();assert.equal((await p.locator('.asset-day h3').innerText()).replace(/\s+/g,' '),'2026-10-01 2 份素材');
 await p.locator('#library-search').fill('秋日');assert.equal(await p.locator('.asset-card').count(),1);
 await p.locator('#library-type').selectOption('video');assert.equal(await p.locator('.asset-card').count(),0);await p.locator('#library-clear').click();
 await p.locator('[data-edit-asset]').first().click();await p.locator('[name="name"]').fill('新名称.png');await p.locator('[name="archiveDate"]').fill('2026-09-28');await p.getByRole('button',{name:'保存修改'}).click();await p.locator('#detail').waitFor({state:'hidden'});
 await p.locator('#library-date').fill('2026-09-28');assert.equal(await p.locator('.asset-card').count(),1);assert.match(await p.locator('.asset-card').innerText(),/新名称/);
 await p.locator('[data-delete-asset]').click();await p.locator('#cancel-delete-asset').click();assert.equal((await app.state()).assets.length,2);
 await p.locator('[data-delete-asset]').click();await p.locator('#confirm-delete-asset').click();await p.locator('#detail').waitFor({state:'hidden'});assert.equal((await app.state()).assets.length,1);assert.equal(await p.locator('.asset-card').count(),0);await p.locator('#library-clear').click();
 await p.screenshot({path:join(tmpdir(),'matrix-assets-preview.png'),fullPage:true});assert.deepEqual(errors,[]);
});
