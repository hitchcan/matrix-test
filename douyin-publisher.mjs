import {douyinVerificationPage,verificationRequired} from './douyin-verification.mjs';
const fail=message=>Object.assign(new Error('抖音：'+message),{state:'needs_manual',status:409});
const ai=/^(?:内容|作品|视频)?\s*(?:包含|含有?|使用了?|由)?\s*(?:AI|人工智能)\s*(?:生成(?:内容)?|辅助创作)$/i;
const none=/^(无需添加(?:自主)?声明|无声明|未声明|不声明|不包含AI(?:生成内容)?|不使用AI)$/i;
const labels=['发文助手自主声明','添加自主声明','自主声明','作品声明'];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function douyinEditorUrl(url){const u=new URL(url);return u.protocol==='https:'&&u.hostname==='creator.douyin.com'&&/^\/creator-micro\/content\/(?:upload|post\/video)\/?$/.test(u.pathname);}

export async function douyinUpload(page,rule){
  const input=page.locator(rule.upload);await input.first().waitFor({state:'attached',timeout:20000});
  if(await input.count()!==1)throw fail('视频上传入口不唯一，请检查后台页面。');
  return input;
}
export async function douyinField(page,kind,rule){
  const choices=[rule[kind]?page.locator(rule[kind]):null,kind==='title'?page.getByPlaceholder(/作品标题|填写标题|添加标题/):page.locator('[contenteditable="true"][data-placeholder*="作品简介"],[contenteditable="true"][data-placeholder*="描述"],.notranslate[contenteditable="true"]')].filter(Boolean);
  const end=Date.now()+(rule.editorTimeoutMs||180000);
  do{
    for(const choice of choices){const visible=choice.filter({visible:true});const count=await visible.count();if(count===1)return visible;if(count>1)throw fail('存在多个'+(kind==='title'?'标题':'简介')+'编辑框，已暂停以避免填错。');}
    await wait(200);
  }while(Date.now()<end);
  throw fail('视频上传处理后未出现编辑框，请检查上传进度或登录状态。');
}

async function declarationControl(page,rule){
  if(rule.aiDisclosure?.trigger){const configured=page.locator(rule.aiDisclosure.trigger).filter({visible:true});return await configured.count()===1?configured:null;}
  const previous=page.locator('[data-matrix-douyin-declaration="true"]').filter({visible:true});if(await previous.count()===1)return previous;
  const placeholder=page.getByText('请选择自主声明',{exact:true}).filter({visible:true});
  if(await placeholder.count()===1){await placeholder.evaluate(n=>(n.closest('[class*="selectBox-"]')||n).setAttribute('data-matrix-douyin-declaration','true'));return page.locator('[data-matrix-douyin-declaration="true"]');}
  const count=await page.evaluate(labels=>{
    document.querySelectorAll('[data-matrix-douyin-declaration]').forEach(n=>n.removeAttribute('data-matrix-douyin-declaration'));
    const visible=n=>Boolean(n.getClientRects().length)&&getComputedStyle(n).visibility!=='hidden';
    const compact=s=>s.replace(/\s+/g,'').replace(/[：:*＊]/g,'');
    const candidates=new Set();
    for(const label of document.querySelectorAll('label,span,div,button,h3,h4')){
      if(!visible(label)||label.closest('[contenteditable="true"]')||!labels.includes(compact(label.textContent))||[...label.children].some(n=>labels.includes(compact(n.textContent))))continue;
      if(label.matches('button,[role="combobox"],[aria-haspopup]')){candidates.add(label);continue;}
      for(let row=label.parentElement,depth=0;row&&row!==document.body&&depth<4;row=row.parentElement,depth++){
        if(row.querySelector('[contenteditable="true"],textarea'))break;
        let options=[...row.querySelectorAll('select,[role="combobox"],[aria-haspopup],button,input[readonly]')].filter(visible).filter(n=>n.tagName==='SELECT'||n.tagName==='INPUT'||compact(n.textContent)&&!/^(发布|保存草稿|帮助|[?？])$/.test(compact(n.textContent)));
        options=options.filter(n=>!options.some(other=>other!==n&&other.contains(n)));
        if(!options.length)options=[...row.querySelectorAll('span,div')].filter(n=>visible(n)&&n!==label&&!n.contains(label)&&/^(无需添加(?:自主)?声明|请选择(?:自主)?声明|无声明|内容由\s*AI\s*生成)$/.test(n.textContent.trim())&&![...n.children].some(c=>c.textContent.trim()===n.textContent.trim()));
        if(options.length===1){candidates.add(options[0].closest('[class*="selectBox-"]')||options[0]);break;}if(options.length>1)break;
      }
    }
    if(candidates.size===1)[...candidates][0].setAttribute('data-matrix-douyin-declaration','true');return candidates.size;
  },labels);
  if(count>1)throw fail('自主声明入口不唯一，已暂停。');
  return count===1?page.locator('[data-matrix-douyin-declaration="true"]'):null;
}
async function declarationDialog(page){
 const count=await page.evaluate(()=>{
  const visible=n=>Boolean(n.getClientRects().length)&&getComputedStyle(n).visibility!=='hidden';const candidates=new Set();
  for(const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span')){
   if(!visible(heading)||heading.textContent.trim()!=='对作品内容添加声明'||[...heading.children].some(n=>n.textContent.trim()===heading.textContent.trim()))continue;
   for(let p=heading.parentElement;p&&p!==document.body;p=p.parentElement){if(p.querySelector('[contenteditable="true"],textarea'))break;if(/请选择声明类型/.test(p.textContent)&&/确定/.test(p.textContent)&&/取消/.test(p.textContent)){candidates.add(p);break;}}
  }
  document.querySelectorAll('[data-matrix-douyin-dialog]').forEach(n=>n.removeAttribute('data-matrix-douyin-dialog'));if(candidates.size===1)[...candidates][0].setAttribute('data-matrix-douyin-dialog','true');return candidates.size;
 });
 if(count>1)throw fail('自主声明弹窗不唯一。');return count===1?page.locator('[data-matrix-douyin-dialog="true"]'):null;
}
async function chooseDialog(dialog,wanted){
 const name=wanted?ai:/^无需添加自主声明$/;
 const label=dialog.locator('label').filter({hasText:name}).filter({visible:true});
 const radio=dialog.getByRole('radio',{name}).filter({visible:true});
 if(await label.count()===1){const input=label.locator('input[type="radio"],input[type="checkbox"]');if(await input.count()!==1||!await input.isChecked())await label.click({timeout:5000});}
 else if(await radio.count()===1)await radio.check({timeout:5000});
 else {const text=dialog.getByText(name,{exact:true}).filter({visible:true});if(await text.count()!==1)throw fail('声明弹窗中没有唯一的目标单选项。');await text.click({timeout:5000});}
 const confirm=dialog.getByRole('button',{name:'确定',exact:true});if(await confirm.count()!==1)throw fail('声明弹窗确定按钮不唯一。');
 // React can update the outer declaration before the modal finishes closing.
 // Do not return early or click the disabled confirmation a second time.
 if(await confirm.isEnabled())await confirm.click({timeout:5000});
 try{await dialog.waitFor({state:'hidden',timeout:10000});}catch{throw fail('声明选项已处理，但弹窗未关闭；请检查确认状态，尚未点击最终发布。');}
}
const choiceValue=control=>control.evaluate(n=>n.tagName==='SELECT'?n.selectedOptions[0]?.textContent?.trim()||'':n.getAttribute('aria-valuetext')||n.value||n.innerText||'');
const stateOf=value=>{const text=value.trim();return ai.test(text)?true:none.test(text)||/^(个人观点[，,]?仅供参考|虚构演绎[，,]?仅供娱乐|取材网络[，,]?谨慎识别)$/.test(text)?false:null;};
async function directCheckbox(page,selector){const c=selector?page.locator(selector):page.getByRole('checkbox',{name:ai});return await c.count()===1?c:null;}
async function setCheckbox(control,wanted){
  if(await control.isChecked()!==wanted){
    if(await control.isVisible())await control.setChecked(wanted,{timeout:5000});
    else {const label=control.page().locator('label').filter({has:control}).filter({visible:true});if(await label.count()!==1)throw fail('AI 声明关联标签不唯一。');await label.click();}
  }
  if(await control.isChecked()!==wanted)throw fail('AI 声明读回不一致，已暂停。');
}
export async function douyinAi(page,wanted,rule,{required=true}={}){
  if(wanted===null)return {state:'unchanged',checked:null};
  let control=await declarationControl(page,rule);
  const existingDialog=await declarationDialog(page);
  if(existingDialog){
    await chooseDialog(existingDialog,wanted);
    const end=Date.now()+5000;do{control=await declarationControl(page,rule);if(control&&stateOf(await choiceValue(control))===wanted)return {state:'applied',checked:wanted,kind:'douyin-dialog'};await wait(100);}while(Date.now()<end);
    throw fail('自主声明弹窗确定后未读回所选状态，已暂停。');
  }
  let checkbox=await directCheckbox(page,rule.aiDisclosure?.selector);
  if(checkbox){await setCheckbox(checkbox,wanted);return {state:'applied',checked:wanted,kind:'douyin-checkbox'};}
  // Opting out does not require adding a declaration to a fresh editor.
  // Only an explicitly selected AI declaration needs to be removed.
  if(wanted===false){
    if(!control)return {state:'not_requested',checked:null,kind:'douyin-no-declaration'};
    const current=await choiceValue(control);
    if(stateOf(current)===false||!current.trim()||/^请选择(?:自主)?声明$/.test(current.trim()))return {state:'unchanged',checked:false,kind:'douyin-no-declaration'};
    if(stateOf(current)!==true)throw fail('当前自主声明状态无法识别，请人工确认是否已有 AI 声明。');
  }
  if(!control){
    const advanced=page.getByText('高级设置',{exact:true}).filter({visible:true});
    if(await advanced.count()===1){const expanded=await advanced.getAttribute('aria-expanded');if(expanded!=='true')await advanced.click();}
    const end=Date.now()+1500;
    do{control=await declarationControl(page,rule);checkbox=await directCheckbox(page,rule.aiDisclosure?.selector);if(control||checkbox)break;await wait(100);}while(Date.now()<end);
  }
  if(checkbox){await setCheckbox(checkbox,wanted);return {state:'applied',checked:wanted,kind:'douyin-checkbox'};}
  if(!control){if(!required)return {state:'pending',checked:null};throw fail('无法唯一定位自主声明，请在可见后台展开高级设置处理。');}
  if(stateOf(await choiceValue(control))===wanted)return {state:'applied',checked:wanted,kind:'douyin-declaration'};
  if(await control.evaluate(n=>n.tagName==='SELECT')){
    const options=await control.locator('option').evaluateAll(ns=>ns.filter(n=>!n.disabled).map(n=>({value:n.value,text:n.textContent.trim()})));
    const matches=options.filter(n=>(wanted?ai:none).test(n.text));if(matches.length!==1)throw fail('未找到唯一的目标声明选项。');await control.selectOption(matches[0].value);
  }else{
    await control.click({timeout:5000});
    let modal=null;const modalEnd=Date.now()+5000;
    do{modal=await declarationDialog(page);if(modal||await page.getByText(wanted?ai:none,{exact:true}).filter({visible:true}).count())break;await wait(100);}while(Date.now()<modalEnd);
    if(modal)await chooseDialog(modal,wanted);
    else {
    const options=page.getByText(wanted?ai:none,{exact:true}).filter({visible:true});
    await options.first().waitFor({state:'visible',timeout:5000});
    // Exclude the trigger's current value and any editable content from option candidates.
    const candidates=await options.evaluateAll(ns=>ns.filter(n=>!n.closest('[contenteditable="true"],[data-matrix-douyin-declaration]')).length);
    if(candidates!==1)throw fail('声明菜单中匹配项不唯一，已暂停。');
    const marked=await options.evaluateAll(ns=>{document.querySelectorAll('[data-matrix-douyin-option]').forEach(n=>n.removeAttribute('data-matrix-douyin-option'));const valid=ns.filter(n=>!n.closest('[contenteditable="true"],[data-matrix-douyin-declaration]'));valid[0]?.setAttribute('data-matrix-douyin-option','true');return valid.length;});
    if(marked!==1)throw fail('目标声明选项不唯一。');
    await page.locator('[data-matrix-douyin-option="true"]').click();
    const dialog=page.getByRole('dialog').filter({visible:true});
    if(await dialog.count()===1){const done=dialog.getByRole('button',{name:/^(确定|保存|完成)$/});if(await done.count()===1)await done.click();}
    }
  }
  const end=Date.now()+5000;
  do{control=await declarationControl(page,rule);if(control&&stateOf(await choiceValue(control))===wanted)return {state:'applied',checked:wanted,kind:'douyin-declaration'};await wait(100);}while(Date.now()<end);
  throw fail('声明选择后未读回所选状态，已暂停提交。');
}

export async function douyinPublishButton(page,rule){
  const button=(rule.submit?page.locator(rule.submit):page.getByRole('button',{name:/^(发布|发布视频|确认发布)$/})).filter({visible:true});
  if(await button.count()!==1)throw fail('最终发布按钮不唯一。');
  const end=Date.now()+(rule.readyTimeoutMs||180000);
  do{if(await button.isEnabled())return button;await wait(250);}while(Date.now()<end);
  throw fail('发布按钮持续不可用，请检查视频转码、封面或其他必填项。');
}
export async function douyinSuccessVisible(page,rule){
  const success=rule.success?page.locator(rule.success):page.getByText(/^(发布成功|视频发布成功|作品发布成功|提交成功|已提交审核)$/);
  try{return await success.filter({visible:true}).evaluateAll(ns=>ns.some(n=>!n.closest('[contenteditable="true"],input,textarea')));}catch(e){if(/Execution context was destroyed|Cannot find context/.test(e.message))return false;throw e;}
}
export async function douyinReceipt(page,rule){
  const end=Date.now()+(rule.resultTimeoutMs||45000);
  do{
    if(await douyinSuccessVisible(page,rule))return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'抖音页面显示本次提交成功；稿件ID、审核和公开状态尚未确认'};
    const verificationPage=await douyinVerificationPage(page);if(verificationPage)throw verificationRequired(verificationPage);
    if(await page.getByRole('alert').filter({hasText:/失败|错误|验证|必填/}).count())throw fail('提交后出现平台提示，请核对作品，勿重复发布。');
    await wait(200);
  }while(Date.now()<end);
  throw fail('提交后未取得确定回执，请人工核对作品，勿重复发布。');
}
