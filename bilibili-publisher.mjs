import {mkdirSync,linkSync,copyFileSync,lstatSync,statSync,constants} from 'node:fs';
import {dirname,basename,extname,join,resolve} from 'node:path';

const fail=message=>Object.assign(new Error('B站视频：'+message),{state:'needs_manual',status:409});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Use disk-backed files through the official picker. Bypassing that entry with
// buffer payloads failed in real first-load testing, before the editor appeared.
export function bilibiliDiskFiles(media){
 return media.map(asset=>{
  const source=resolve(asset.path),extension=extname(asset.name).toLowerCase();
  if(!/^\.(mp4|flv|avi|wmv|mov|webm|mpeg4|ts|mpg|rm|rmvb|mkv|m4v|vob|swf|3gp|mts|m2v|m2ts|f4v|m2t|3g2|asf)$/.test(extension))throw fail('视频文件缺少支持的扩展名。');
  let name=String(asset.name).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'');
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
  if(name.length>180)name=name.slice(0,160)+extension;
  const folder=join(dirname(source),'.browser-upload',basename(source)),file=join(folder,name);
  mkdirSync(folder,{recursive:true});
  try{linkSync(source,file);}catch(e){
   if(e.code!=='EEXIST'){try{copyFileSync(source,file,constants.COPYFILE_EXCL);}catch(copyError){if(copyError.code!=='EEXIST')throw copyError;}}
  }
  const staged=lstatSync(file);if(!staged.isFile()||staged.isSymbolicLink()||staged.size!==statSync(source).size)throw fail('磁盘上传文件校验失败。');
  return file;
 });
}
export async function bilibiliUpload(page,rule){
 const end=Date.now()+20000;
 do{
  const area=page.locator(rule.uploadTrigger||'.bcc-upload-wrapper .upload-area'),visible=area.filter({visible:true});
   if(await visible.count()>1)throw fail('存在多个可见视频上传入口。');
   if(await visible.count()===1)return {
    count:()=>visible.count(),
    setInputFiles:async(files,{timeout=30000}={})=>{
     // Opening the official picker performs the site's click/initialization
     // sequence before selection. Setting the hidden input directly skips it.
     try{const [chooser]=await Promise.all([page.waitForEvent('filechooser',{timeout}),visible.click({timeout})]);await chooser.setFiles(files,{timeout});}
     catch{throw fail('官方上传入口未完成文件选择，请检查页面验证或上传限制。');}
    },
   };
  // The library's buploader input appears before the Vue upload entry. Using
  // it here skips task initialization and never opens the title editor.
  await wait(100);
 }while(Date.now()<end);throw fail('未出现视频上传入口。');
}
export async function bilibiliField(page,kind,rule){
 const field=page.locator(rule[kind]).filter({visible:true});await field.first().waitFor({state:'visible',timeout:60000});if(await field.count()!==1)throw fail('标题或简介编辑器不唯一。');return field;
}
export async function bilibiliAi(page,wanted,{required=true}={}){
 if(wanted===null)return {state:'unchanged',checked:null};
 const input=page.locator('input.bcc-select-input-inner[placeholder*="创作声明"]').filter({visible:true});
 if(await input.count()===0&&wanted===false)return {state:'not_requested',checked:null,kind:'bilibili-no-declaration'};
 if(await input.count()!==1){if(!required)return {state:'pending',checked:null};throw fail('未找到唯一的创作声明选择器。');}
 const ai=/^含\s*AI\s*生成内容$/i,other=/^(内容无需标注|含虚构演绎内容|内容含营销信息|个人观点[，,]仅供参考|内容为转载)$/;
 const current=(await input.inputValue()).trim();
 const unset=!current||current==='请选择符合您视频内容的创作声明';
 if((ai.test(current)?true:other.test(current)?false:null)===wanted)return {state:'applied',checked:wanted,value:current,kind:'bilibili-declaration'};
 if(wanted===false&&!unset&&!ai.test(current))throw fail('当前创作声明状态无法识别，请人工确认是否已有 AI 声明。');
 const select=input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bcc-select ")][1]');
 if(await select.count()!==1)throw fail('创作声明容器不唯一。');
 await select.locator('.bcc-select-input-wrap').click({timeout:5000});
 const option=select.locator('.bcc-option').filter({hasText:wanted?ai:/^内容无需标注$/}).filter({visible:true});await option.first().waitFor({state:'visible',timeout:5000});
 if(await option.count()!==1)throw fail('创作声明选项不唯一。');await option.click({timeout:5000});
 const end=Date.now()+5000;do{const value=(await input.inputValue()).trim();if((ai.test(value)?true:other.test(value)?false:null)===wanted)return {state:'applied',checked:wanted,value,kind:'bilibili-declaration'};await wait(100);}while(Date.now()<end);
 throw fail('创作声明未读回一致状态，未提交。');
}
export function bilibiliEditorUrl(url){const u=new URL(url);return u.protocol==='https:'&&u.hostname==='member.bilibili.com'&&/^\/platform\/upload\/video\/(?:frame|edit)\/?$/.test(u.pathname);}
export async function bilibiliPublishButton(page,rule){
 const button=page.locator(rule.submit||'.submit-container .submit-actions .submit-add').filter({visible:true});
 if(await button.count()!==1)throw fail('最终“立即投稿”控件不唯一。');
 const end=Date.now()+(rule.readyTimeoutMs||60000);do{
  const enabled=await button.evaluate(n=>{for(let p=n,depth=0;p&&depth<4;p=p.parentElement,depth++){if(p.hasAttribute('disabled')||p.getAttribute('aria-disabled')==='true'||p.getAttribute('aria-busy')==='true'||/(^|[\s_-])disabled($|[\s_-])/.test(p.className))return false;}return true;});
  if(enabled)return button;await wait(200);
 }while(Date.now()<end);throw fail('立即投稿持续不可用，请处理必填项或等待视频上传完成。');
}
export async function bilibiliSuccessVisible(page,rule){
 const s=rule.success?page.locator(rule.success):page.getByText(/^(投稿成功|稿件投递成功|投稿成功！|稿件提交成功|已提交审核)$/);
 return s.filter({visible:true}).evaluateAll(ns=>ns.some(n=>!n.closest('[contenteditable="true"],textarea,input')));
}
export async function bilibiliReceipt(page,rule){
 const end=Date.now()+(rule.resultTimeoutMs||45000);do{
  if(await bilibiliSuccessVisible(page,rule))return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'B站页面显示本次投稿成功；稿件ID、审核及公开状态尚未确认'};
  if(await page.getByRole('alert').filter({hasText:/失败|错误|必填|不能为空|验证/}).count())throw fail('提交后出现平台提示，结果待核对，请勿重发。');await wait(200);
 }while(Date.now()<end);throw fail('最终点击后未取得明确投稿回执，请人工核对，勿重复投稿。');
}
