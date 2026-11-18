const fail=message=>Object.assign(new Error('快手：'+message),{state:'needs_manual',status:409});
export function kuaishouEditorUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='cp.kuaishou.com'&&/^\/article\/publish\/video\/?$/.test(u.pathname);}catch{return false;}
}
export async function kuaishouUpload(page,rule){
  if(!kuaishouEditorUrl(page.url()))throw fail('当前页面不是官方视频发布页。');
  const input=page.locator(rule.upload);
  await input.first().waitFor({state:'attached',timeout:rule.readyTimeoutMs||30000});
  if(await input.count()!==1)throw fail('视频上传入口不唯一，已暂停。');
  return input;
}
export function kuaishouDescription(content){
  const version=content.versions?.kuaishou||{},title=version.title||content.title||'',body=version.body||content.body||'';
  return title.trim()===body.trim()?title:[title,body].filter(s=>s.trim()).join('\n');
}
export async function kuaishouField(page,rule){
  const field=page.locator(rule.body);
  await field.first().waitFor({state:'visible',timeout:rule.editorTimeoutMs||180000});
  if(await field.count()!==1)throw fail('作品描述编辑框不唯一。');
  return field;
}
export async function kuaishouCheckDescription(page,content,rule){
  const field=await kuaishouField(page,rule),actual=await field.innerText();
  const normalize=s=>s.replace(/\r\n/g,'\n').replace(/\u200b/g,'').trim();
  if(normalize(actual)!==normalize(kuaishouDescription(content)))throw fail('页面文案已变化，请核对并恢复任务文案后重试。');
}
async function declaration(page){
  const row=page.locator('[class*="_edit-form-item_"]').filter({has:page.locator('label').filter({hasText:/^作者声明$/})});
  const control=row.locator('.ant-select').filter({visible:true});
  if(await control.count()!==1)throw fail('作者声明控件缺失或不唯一。');
  return control;
}
async function selected(control){
  const items=control.locator('.ant-select-selection-item');
  if(await items.count()>1)throw fail('作者声明当前值不唯一。');
  return await items.count()?(await items.innerText()).trim():'';
}
export async function kuaishouAi(page,wanted){
  if(wanted===null)return {state:'unchanged',checked:null};
  let control=await declaration(page),value=await selected(control);
  if(wanted&&value!=='内容为AI生成'){
    const trigger=control.locator('.ant-select-selector');
    const expanded=control.getByRole('combobox');
    if(await expanded.getAttribute('aria-expanded')!=='true')await trigger.click();
    // Saved DOM places the visible options inside this select, separately from
    // the zero-sized ARIA listbox. Never choose hidden copies by text alone.
    const option=control.locator('.ant-select-item-option[title="内容为AI生成"]').filter({visible:true});
    await option.first().waitFor({state:'visible',timeout:5000});
    if(await option.count()!==1)throw fail('AI 声明选项不唯一。');
    await option.click();
  }else if(!wanted&&value==='内容为AI生成'){
    await control.hover();const clear=control.locator('.ant-select-clear').filter({visible:true});
    if(await clear.count()!==1)throw fail('无法确认 AI 声明的清除入口，请人工取消。');
    await clear.click();
  }
  const end=Date.now()+5000;
  do{
    control=await declaration(page);value=await selected(control);
    if(wanted?value==='内容为AI生成':['','演绎情节，仅供娱乐','个人观点，仅供参考','素材来源于网络'].includes(value)){
      if(await control.getByRole('combobox').getAttribute('aria-expanded')==='true'){
        await control.getByRole('combobox').press('Escape');
        if(await control.getByRole('combobox').getAttribute('aria-expanded')==='true')throw fail('作者声明菜单尚未关闭。');
      }
      return {state:'applied',checked:wanted,kind:'kuaishou-select'};
    }
    await new Promise(r=>setTimeout(r,100));
  }while(Date.now()<end);
  throw fail('作者声明未读回所选状态，已暂停提交。');
}
export async function kuaishouPublishButton(page){
  // A native platform schedule would change the meaning of a local dispatch.
  const immediate=page.locator('[class*="_edit-form-item_"]').filter({has:page.locator('label').filter({hasText:/^发布时间$/})}).getByRole('radio',{name:'立即发布',exact:true});
  if(await immediate.count()!==1||!await immediate.isChecked()||await immediate.locator('xpath=ancestor::div[contains(@class,"ant-radio-group")]').locator('input[type="radio"]:checked').count()!==1)throw fail('发布时间不是立即发布，请人工核对；工具定时任务由本机调度。');
  const button=page.locator('[class*="_edit-section-btns_"] [class*="_button-primary_"]').filter({hasText:/^发布$/}).filter({visible:true});
  if(await button.count()!==1)throw fail('最终发布按钮缺失或不唯一。');
  if(!await button.evaluate(n=>!n.matches('[disabled],[aria-disabled="true"]')&&!/(?:^|[\s_-])disabled(?:[\s_-]|$)/i.test(n.className)&&getComputedStyle(n).pointerEvents!=='none'))throw fail('最终发布按钮不可用，请检查上传及必填项。');
  return button;
}
export async function kuaishouSuccessVisible(page){
  if(new URL(page.url()).hostname!=='cp.kuaishou.com')return false;
  return await page.getByText(/^(?:作品|视频)?发布成功(?:[！!。，,\s].{0,100})?$/,{exact:true}).filter({visible:true}).count()>0;
}
export function watchKuaishouSubmission(page){
  let accepted=false,acceptedPath=null,active=true,ui=false,busy=false;
  const diagnostics=[];
  // Start before click(), whose navigation wait can outlive a transient toast.
  const timer=setInterval(async()=>{if(busy||!active)return;busy=true;try{if(await kuaishouSuccessVisible(page))ui=true;}catch{}finally{busy=false;}},50);
  const listener=async response=>{try{const u=new URL(response.url());
    if(u.origin!=='https://cp.kuaishou.com'||response.request().method()!=='POST')return;
    const path=u.pathname;
    if(!/\/rest\/cp\/works\/v2\/video\/pc\/(?:submit|publish)\b/.test(path))return;
    const status=response.status();
    const json=await response.json().catch(()=>null);
    const result=typeof json?.result==='number'?json.result:'未知';
    const code=typeof json?.code==='number'?json.code:'未知';
    if(active){
      const data=json&&typeof json.data==='object'&&json.data?Object.keys(json.data).slice(0,8).join('|'):'';
      diagnostics.push(`${path} HTTP ${status} result=${result} code=${code}${data?' data键='+data:''}`);
      // The console publishes through /pc/publish (observed call:
      // /pc/publish/refresh); older builds used /pc/submit. Accept only a 2xx
      // response whose own envelope reports success.
      if(status>=200&&status<300&&(json?.result===1||json?.code===0)){accepted=true;acceptedPath=path;}
    }
  }catch{}};
  page.on('response',listener);
  return {accepted:()=>accepted,path:()=>acceptedPath,ui:()=>ui,diagnostics:()=>diagnostics.slice(-3).join('；'),close:()=>{active=false;clearInterval(timer);page.off('response',listener);}};
}
export async function kuaishouReceipt(page,rule,capture){
  const end=Date.now()+(rule.resultTimeoutMs||45000);
  do{
    if(capture?.accepted())return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:`本次官方提交响应 ${capture.path?.()||''} result=1，平台已接受投稿；审核及公开状态未确认`};
    if(capture?.ui?.()||await kuaishouSuccessVisible(page))return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'本次点击后官方页面显示发布成功；审核与公开状态未确认'};
    await new Promise(r=>setTimeout(r,200));
  }while(Date.now()<end);
  throw fail('最终点击后未取得明确发布成功提示，请人工核对，禁止自动重发。'+(capture?.diagnostics?.()?'本次提交诊断：'+capture.diagnostics():'')+`；当前页面=${(()=>{try{return page.url();}catch{return '—';}})()}`);
}
