import {xhsClosedPublishButton} from './xhs-closed-publish.mjs';
const fail=message=>Object.assign(new Error('小红书：'+message),{state:'needs_manual',status:409});
export function xhsEditorUrl(url){const u=new URL(url);return u.protocol==='https:'&&u.hostname==='creator.xiaohongshu.com'&&u.pathname.startsWith('/publish/');}

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function modeControl(page,type,rule){
  const selector=rule.modeSelectors?.[type]||null;
  return page.evaluate(({type,selector})=>{
    const name=type==='note'?'上传图文':'上传视频';
    const compact=s=>s.replace(/\s+/g,'');
    const available=n=>{
      if(n.closest('[contenteditable="true"],input,textarea')||n.matches(':disabled,[aria-disabled="true"]'))return false;
      for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||p.getAttribute('aria-hidden')==='true')return false;}
      const r=n.getBoundingClientRect();
      if(!r.width||!r.height||r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)return false;
      const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
      const hit=document.elementFromPoint(x,y);return Boolean(hit&&n.contains(hit));
    };
    const structured=[...document.querySelectorAll('[role="tab"],.creator-tab')].filter(n=>[name,type==='note'?'图文':'视频',type==='note'?'发布图文':'发布视频'].includes(compact(n.textContent)));
    let candidates=selector?[...document.querySelectorAll(selector)]:structured;
    if(!selector&&!structured.length)candidates=[...document.querySelectorAll('button,span,div,a')].filter(n=>compact(n.textContent)===name&&![...n.children].some(c=>compact(c.textContent)===name)).map(n=>n.closest('button,[role="button"]')||n);
    candidates=[...new Set(candidates)].filter(available);
    document.querySelectorAll('[data-matrix-xhs-mode]').forEach(n=>n.removeAttribute('data-matrix-xhs-mode'));
    if(candidates.length===1){const n=candidates[0];n.setAttribute('data-matrix-xhs-mode','true');return {count:1,active:n.getAttribute('aria-selected')==='true'||n.classList.contains('active')};}
    return {count:candidates.length,active:false};
  },{type,selector});
}

async function uploadControl(page,type,rule){
  return page.evaluate(({type,selector})=>{
    const desired=type==='note'?/image\/|\.(?:jpe?g|png|webp|gif|heic|heif|avif)\b/i:/video\/|\.(?:mp4|mov|m4v|mkv|flv|f4v|rmvb?|mpeg|mpg|ts)\b/i;
    const configured=selector?[...document.querySelectorAll(selector)]:[];
    const inputs=(configured.length?configured:[...document.querySelectorAll('input[type="file"]')].filter(n=>desired.test(n.accept))).filter(n=>{
      if(n.disabled)return false;
      // The native file input may be hidden; its publishing pane must be active.
      for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||p.getAttribute('aria-hidden')==='true')return false;}
      return true;
    });
    document.querySelectorAll('[data-matrix-xhs-upload]').forEach(n=>n.removeAttribute('data-matrix-xhs-upload'));
    if(inputs.length===1)inputs[0].setAttribute('data-matrix-xhs-upload','true');return inputs.length;
  },{type,selector:rule.upload||null});
}

export async function xhsMode(page,type,rule){
  const name=type==='note'?'上传图文':'上传视频',end=Date.now()+(rule.modeTimeoutMs??20000);
  let matches=0;
  do{
    const found=await modeControl(page,type,rule);matches=found.count;
    if(found.count===1){if(!found.active)await page.locator('[data-matrix-xhs-mode="true"]').click({timeout:10000});return;}
    // Some versions open directly in the requested uploader without rendering tabs.
    if(found.count===0&&await uploadControl(page,type,rule)===1)return;
    await wait(150);
  }while(Date.now()<end);
  throw fail(matches>1?'存在多个可操作的“'+name+'”入口，未点击，请检查发布页或配置 modeSelectors。':'等待发布页加载后仍未找到可操作的“'+name+'”入口，请检查登录或验证提示。');
}

export async function xhsUpload(page,type,rule){
  const end=Date.now()+(rule.uploadTimeoutMs??20000);let count=0;
  do{count=await uploadControl(page,type,rule);if(count===1)return page.locator('[data-matrix-xhs-upload="true"]');await wait(150);}while(Date.now()<end);
  throw fail(count>1?'当前发布面板有多个上传控件，已暂停。':'切换发布类型后未出现对应的上传控件，请检查后台提示。');
}

export async function xhsField(page,kind,rule){
  const configured=rule[kind];
  const choices=[configured?page.locator(configured):null,kind==='title'?page.getByPlaceholder(/填写标题|添加标题|输入标题/):page.locator('.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]')].filter(Boolean);
  const end=Date.now()+20000;
  do{for(const locator of choices){const visible=locator.filter({visible:true});if(await visible.count()===1)return visible;if(await visible.count()>1)throw fail('存在多个'+(kind==='title'?'标题':'正文')+'输入框，已暂停。');}await new Promise(r=>setTimeout(r,150));}while(Date.now()<end);
  throw fail('上传后未出现'+(kind==='title'?'标题':'正文')+'编辑器，请检查素材处理或登录状态。');
}

export async function xhsPublishButton(page,rule){
  if(!rule.submit){const enclosed=await xhsClosedPublishButton(page);if(enclosed){const end=Date.now()+(rule.readyTimeoutMs||60000);do{if(await enclosed.isEnabled())return enclosed;await wait(200);}while(Date.now()<end);throw fail('红色发布按钮持续不可用，请检查页面必填项。');}}
  let button=rule.submit?page.locator(rule.submit).filter({visible:true}):page.getByRole('button',{name:'发布',exact:true}).filter({visible:true});
  if(!rule.submit&&await button.count()!==1){
    // “发布笔记” in the sidebar opens navigation. Only the editor action bar
    // can supply the alternative label or resolve duplicate “发布” nodes.
    const choices=await button.count()?button:page.getByRole('button',{name:'发布笔记',exact:true}).filter({visible:true});
    const count=await choices.evaluateAll(nodes=>{
      document.querySelectorAll('[data-matrix-xhs-final]').forEach(n=>n.removeAttribute('data-matrix-xhs-final'));
      const final=nodes.filter(n=>{
        if(n.closest('aside,nav,[role="navigation"]'))return false;
        for(let p=n.parentElement,depth=0;p&&p!==document.body&&depth<4;p=p.parentElement,depth++){
          if(p.querySelector('[contenteditable="true"],textarea'))break;
          if(p.tagName==='FOOTER'||/footer|publish-actions|publish-button|publish-btn/i.test(p.className)||/暂存离开/.test(p.textContent))return true;
        }return false;
      });
      const visible=final.filter(n=>{const r=n.getBoundingClientRect();if(r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return false;const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&n.contains(hit);});
      const candidates=visible.length?visible:final;if(candidates.length===1)candidates[0].setAttribute('data-matrix-xhs-final','true');return candidates.length;
    });
    if(count===1)button=page.locator('[data-matrix-xhs-final="true"]');
    else throw fail('未找到唯一的编辑器最终发布按钮，已排除侧栏“发布笔记”入口。');
  }
  if(await button.count()!==1)throw fail('最终发布按钮不唯一。');
  const end=Date.now()+(rule.readyTimeoutMs||60000);
  do{if(await button.isEnabled({timeout:1000}))return button;await new Promise(r=>setTimeout(r,200));}while(Date.now()<end);
  throw fail('发布按钮持续不可用，请检查上传进度、封面或声明等必填项。');
}

export async function xhsReceipt(page,rule){
  const end=Date.now()+(rule.resultTimeoutMs||45000);
  do{
    if(await xhsSuccessVisible(page,rule))return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'小红书页面显示本次提交成功；公开状态及稿件ID尚未确认'};
    const alert=page.getByRole('alert').filter({hasText:/失败|错误|验证|必填/});if(await alert.count())throw fail('提交后出现平台提示，结果待确认，请核对作品，勿重复发布。');
    await new Promise(r=>setTimeout(r,200));
  }while(Date.now()<end);
  throw fail('最终提交后未取得确定回执，请人工核对稿件，勿重复发布。');
}
export async function xhsSuccessVisible(page,rule){
  const success=rule.success?page.locator(rule.success):page.getByText(/^(发布成功|笔记发布成功|提交成功|已提交审核|提交成功，审核中)$/);
  return success.filter({visible:true}).evaluateAll(ns=>ns.some(n=>!n.closest('[contenteditable="true"],input,textarea')));
}
