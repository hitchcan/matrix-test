export async function douyinVerificationPage(page){
 for(const candidate of [page,...page.context().pages().filter(p=>p!==page)]){
  if(candidate.isClosed())continue;
  let u;try{u=new URL(candidate.url());}catch{continue;}
  if(!/(^|\.)(douyin\.com|bytedance\.com|snssdk\.com)$/.test(u.hostname))continue;
  for(const frame of candidate.frames()){
   if(frame!==candidate.mainFrame()){try{if(!await(await frame.frameElement()).isVisible())continue;}catch{continue;}}
  let found;try{found=await frame.evaluate(()=>{
   const visible=n=>{const r=n.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(n).visibility!=='hidden';};
   const selectors='#captcha_container,[id^="captcha_container"],.captcha_verify_container,.secsdk-captcha-wrapper,.secsdk-captcha-drag-wrapper,[class*="captcha-verify"],[data-testid*="captcha"],.verify-dialog';
   if([...document.querySelectorAll(selectors)].some(visible))return true;
   if([...document.querySelectorAll('[role="dialog"],.verify-wrap')].some(n=>visible(n)&&/安全验证|完成验证|拖动滑块|验证码|验证身份/.test(n.textContent)))return true;
   // SMS identity verification is often a plain div, without dialog roles or
   // captcha classes. Read only its form structure, never the code or number.
   const codeInputs=[...document.querySelectorAll('input')].filter(n=>visible(n)&&!n.closest('[contenteditable="true"]')&&(/验证码|verification.code|\botp\b/i.test(n.getAttribute('placeholder')||'')||n.autocomplete==='one-time-code'));
   for(const input of codeInputs){for(let p=input.parentElement,depth=0;p&&p!==document.body&&depth<9;p=p.parentElement,depth++){
    if(!visible(p)||p.querySelector('[contenteditable="true"],textarea'))break;
    if(/接收短信验证码|短信验证|验证身份|为确保是本人操作/.test(p.textContent)&&/获取验证码|发送验证码|重新获取|重新发送/.test(p.textContent))return true;
   }}
   return [...document.querySelectorAll('iframe')].some(n=>{if(!visible(n))return false;try{const u=new URL(n.src);return /(^|\.)(douyin\.com|bytedance\.com|snssdk\.com)$/.test(u.hostname)&&/captcha|verify/i.test(u.pathname);}catch{return false;}});
  });}catch(e){if(candidate.isClosed()||/Execution context was destroyed|Cannot find context/.test(e.message))continue;throw e;}
  if(found)return candidate;
  }
 }
 return null;
}
export function verificationRequired(page){return Object.assign(new Error('抖音要求人工完成安全验证。请在保留的浏览器页面中验证；完成后只核对发布结果，不重复点击发布。'),{state:'needs_verification',verificationPage:page});}
