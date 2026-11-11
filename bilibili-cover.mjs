import {readFileSync} from 'node:fs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const manual=message=>Object.assign(new Error('B站封面：'+message),{state:'awaiting_confirmation',status:409});
export async function bilibiliCoverReady(page){
 const root=page.locator('.cover-module-main').filter({visible:true});
 if(await root.count()!==1)return false;
 return root.evaluate(n=>!n.querySelector('.cover-empty')&&(
  [...n.querySelectorAll('img')].some(i=>i.getAttribute('src')&&i.alt!=='add'&&i.complete&&i.naturalWidth>0)||
  [...n.querySelectorAll('.cover-slot,.cover-img,[class*="preview"],[class*="image"]')].some(p=>/url\(/.test(getComputedStyle(p).backgroundImage))
 ));
}
export async function requireBilibiliCover(page){
 if(!await bilibiliCoverReady(page))throw manual('尚未设置有效封面。请打开任务浏览器添加封面，再确认提交；工具尚未点击“立即投稿”。');
}
export async function uploadBilibiliCover(page,asset){
 if(!asset||!/^image\/(png|jpeg)$/.test(asset.mime))throw manual('请选择一张PNG或JPEG封面图片。');
 const entry=page.locator('.cover-module-main .cover-slot').filter({visible:true});
 if(await entry.count()!==1)throw manual('未找到唯一的封面入口，请在后台设置。');
 await entry.click({timeout:10000});
 const dialog=page.locator('.cover-editor.bcc-dialog__wrap').filter({visible:true});await dialog.waitFor({state:'visible',timeout:10000});
 const upload=dialog.locator('.cover-editor-panel-select .cover-upload .upload-area').filter({visible:true});
 if(await upload.count()!==1)throw manual('封面编辑器上传入口不唯一，请人工处理。');
 const [chooser]=await Promise.all([page.waitForEvent('filechooser',{timeout:10000}),upload.click({timeout:10000})]);
 await chooser.setFiles({name:asset.name,mimeType:asset.mime,buffer:readFileSync(asset.path)},{timeout:30000});
 const end=Date.now()+30000;
 do{if(!await dialog.locator('.cover-editor-panel-canvas-empty').filter({visible:true}).count())break;await wait(150);}while(Date.now()<end);
 if(await dialog.locator('.cover-editor-panel-canvas-empty').filter({visible:true}).count())throw manual('图片仍未进入两个比例的封面画布，请人工调整。');
 await finishBilibiliCover(page,dialog);
}
export async function finishBilibiliCover(page,dialog){
 const sync=page.locator('.videoup-confirm-modal').filter({visible:true}).filter({hasText:/是否将.*4:3.*同步.*16:9/s});
 if(!await sync.count()){
  const done=dialog.locator('.cover-editor-button .submit').filter({hasText:/^\s*完成\s*$/}).filter({visible:true});
  if(await done.count()!==1)throw manual('封面“完成”按钮不唯一。');await done.click({timeout:10000});
 }
 let synced=false;
 const savedEnd=Date.now()+15000;do{
  if(await sync.count()){
   if(synced||await sync.count()!==1)throw manual('封面比例同步确认状态异常，请人工处理。');
   const confirm=sync.getByText('确认同步',{exact:true});if(await confirm.count()!==1)throw manual('封面比例同步按钮不唯一。');await confirm.click({timeout:5000});synced=true;
  }
  if(!await dialog.isVisible()&&await bilibiliCoverReady(page))return;await wait(150);
 }while(Date.now()<savedEnd);
 throw manual('未读到已保存的封面，请在后台调整并点击完成。');
}
