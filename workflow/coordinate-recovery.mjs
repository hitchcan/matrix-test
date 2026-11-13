import {randomUUID} from 'node:crypto';
const openedMenus=new WeakMap();

// These goals come from the immutable task and the failing preparation stage,
// never from page text or the recovery model.
export function preparationGoal(content,platform,stage,code){
  if(platform==='douyin'&&['public','private'].includes(content.publication?.douyinVisibility)&&(code==='visibility_unconfirmed'||stage==='设置抖音视频可见范围'))return {kind:'visibility',desired:content.publication.douyinVisibility==='private'?'仅自己可见':'公开'};
  if(typeof content.publication?.aiAssisted==='boolean'&&/AI.*声明|创作声明/.test(stage))return {kind:'declaration',desired:content.publication.aiAssisted?'AI辅助创作':'不使用AI声明'};
  if(code==='image_upload_failed')return {kind:'media',desired:'恢复本任务图片上传，然后交回标准上传工具'};
  return null;
}

export function validVisualAction(a,o){
  if(!a||a.token!==o.token||!o.actions.includes(a.action))return false;
  const keys=a.action==='click_at'?['action','token','x','y','goal']:a.action==='click'?['action','token','targetId']:a.action==='scroll'?['action','token','direction']:['action','token'];
  if(Object.keys(a).length!==keys.length||keys.some(k=>!Object.hasOwn(a,k)))return false;
  if(a.action==='click_at')return o.coordinateMode===true&&a.goal===o.goal.kind&&Number.isSafeInteger(a.x)&&Number.isSafeInteger(a.y)&&a.x>=0&&a.y>=0&&a.x<o.viewport.width&&a.y<o.viewport.height;
  if(keys.some(k=>typeof a[k]!=='string'))return false;
  if(a.action==='click')return !!o.targets?.some(t=>t.id===a.targetId);
  return a.action!=='scroll'||['up','down'].includes(a.direction);
}

export async function observeCoordinateRecovery(page,hosts,editor){
  const goal=editor?.coordinateGoal;
  const kinds={visibility:['仅自己可见','公开'],declaration:['AI辅助创作','不使用AI声明'],media:['恢复本任务图片上传，然后交回标准上传工具']};
  if(!goal||!kinds[goal.kind]?.includes(goal.desired)||page.isClosed())return {human:true};
  const url=page.url(),u=new URL(url),base=new URL(editor.url);
  const editorPath=u.pathname===base.pathname||(editor.platform==='douyin'&&/^\/creator-micro\/content\/(upload|post\/video)\/?$/.test(u.pathname));
  if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.origin!==base.origin||!editorPath)return {human:true};
  const hint=openedMenus.get(page);
  const portalAllowed=!!hint&&hint.url===url&&hint.goal===JSON.stringify(goal)&&Date.now()-hint.at<20000&&await page.evaluate(d=>document===d,hint.document).catch(()=>false);
  if(hint&&!portalAllowed){openedMenus.delete(page);await hint.document.dispose().catch(()=>{});}
  const context=page.context();
  const closePopup=p=>{void p.close().catch(()=>{});};
  const closeOwnedPage=p=>{void p.opener().then(opener=>{if(opener===page)return p.close();}).catch(()=>{});};
  // Exploration only changes local UI. Standard adapters own uploads, autosave
  // and final submission. Even GET requests are blocked during coordinate work.
  const guard=async route=>{try{if(route.request().frame().page()===page||await route.request().frame().page().opener()===page)return route.abort();}catch{return route.abort();}return route.fallback();};
  await context.route('**/*',guard);page.on('popup',closePopup);context.on('page',closeOwnedPage);
  let state;
  const dispose=async()=>{page.off('popup',closePopup);context.off('page',closeOwnedPage);await context.unroute('**/*',guard).catch(()=>{});if(state){await state.evaluate(s=>{s.observer?.disconnect();if(s.inputGuard)for(const t of ['pointerdown','mousedown','mouseup','click','submit'])window.removeEventListener(t,s.inputGuard,true);if(s.externalChange)for(const t of ['input','change','scroll','resize'])window.removeEventListener(t,s.externalChange,true);document.querySelectorAll('[data-matrix-coordinate-scope],[data-matrix-coordinate-sensitive]').forEach(n=>{n.removeAttribute('data-matrix-coordinate-scope');n.removeAttribute('data-matrix-coordinate-sensitive');});}).catch(()=>{});await state.dispose().catch(()=>{});}};
  try{
    state=await page.evaluateHandle(({goal,portalAllowed})=>{
      const visible=n=>!!n?.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
      const text=n=>(n.getAttribute('aria-label')||n.getAttribute('title')||n.textContent||'').trim().replace(/\s+/g,'');
      const challenge=()=>!!navigator.serviceWorker?.controller||[...document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]')].some(visible)||/短信验证|请扫码|请扫描二维码|请完成安全验证|接收短信验证码/.test(document.body.innerText);
      const headings=goal.kind==='visibility'?/^(谁可以看|可见范围|观看权限|发布权限|权限设置)[：:*＊]*$/:goal.kind==='declaration'?/^(自主声明|发文助手自主声明|添加自主声明|作品声明|创作声明|内容声明|内容类型声明|对作品内容添加声明)[：:*＊]*$/:/^(正文图片|图片上传|上传图片|图片素材|配图)[：:*＊]*$/;
      const controls='button,select,input,[role=button],[role=combobox],[role=radio],[role=checkbox],[role=option],[aria-haspopup],summary,[class*="selectBox"],[class*="select-box"]';
      const roots=new Set();
      document.querySelectorAll('[data-matrix-coordinate-scope],[data-matrix-coordinate-sensitive]').forEach(n=>{n.removeAttribute('data-matrix-coordinate-scope');n.removeAttribute('data-matrix-coordinate-sensitive');});
      for(const h of document.querySelectorAll('label,span,div,h2,h3,h4')){
        if(!visible(h)||h.closest('header,nav,aside,[contenteditable],textarea')||!headings.test(text(h))||[...h.children].some(c=>headings.test(text(c))))continue;
        for(let row=h.parentElement,i=0;row&&row!==document.body&&i<5;row=row.parentElement,i++){
          if(row.querySelector('[contenteditable],textarea,header,nav,aside')||row.textContent.length>1500)break;
          if(row.querySelector(controls)){roots.add(row);break;}
        }
      }
      // Visible portal menus are eligible only when their content belongs to
      // the active goal; unrelated account/security menus remain inaccessible.
      for(const menu of document.querySelectorAll('[role=listbox],[role=menu],[role=dialog],dialog[open]'))if(visible(menu)&&menu.textContent.length<1500&&headings.test(text(menu.querySelector('h2,h3,h4')||menu)))roots.add(menu);
      for(const n of document.querySelectorAll('button,[role=button],summary'))if(visible(n)&&/^(高级设置|更多设置|展开设置|展开|更多|继续编辑|返回编辑|关闭|知道了|我知道了)$/.test(text(n))&&!n.closest('header,nav,aside,a'))roots.add(n);
      // Plain custom menus may use divs without ARIA roles. Only expose exact
      // task values and local expansion controls, never arbitrary page prose.
      const aiOption=n=>/^(内容|作品|视频|笔记)?(包含|含有|使用|由)?(AI|人工智能)(生成内容|生成|辅助创作)(作者对内容负责)?$/.test(text(n));
      const desired=n=>goal.kind==='visibility'?text(n)===goal.desired:goal.kind==='declaration'?(goal.desired==='AI辅助创作'?aiOption(n):/^(无声明|无需添加声明|无需添加自主声明|不使用AI|不包含AI生成内容)$/.test(text(n))):false;
      if(portalAllowed)for(const n of document.querySelectorAll('[role=option],label,div,span'))if(visible(n)&&desired(n)&&![...n.children].some(desired)&&!n.closest('header,nav,aside,[contenteditable],textarea'))roots.add(n.closest('[role=option],label')||n);
      for(const n of roots)n.setAttribute('data-matrix-coordinate-scope','true');
      for(const n of document.querySelectorAll('[data-matrix-coordinate-scope] *'))if(!n.children.length&&/(?:1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(n.textContent))n.setAttribute('data-matrix-coordinate-sensitive','true');
      const forbidden=/发布|提交|发送|删除|移除|付款|支付|转账|购买|订阅|登录|退出|扫码|验证码|验证身份|安全验证|绑定|解绑|授权|修改密码|保存权限|允许下载|允许保存|publicar|publish|submit|delete|payment|login/i;
      const safe=n=>{
        if(!n?.isConnected||!visible(n)||n.disabled||n.getAttribute('aria-disabled')==='true'||n.closest('a,iframe,header,nav,aside,[contenteditable],textarea,[data-sensitive]'))return false;
        if(n.matches('input,select,canvas,svg,iframe'))return false;
        if(n.closest('form')&&n.matches('button')&&n.type!=='button')return false;
        if(![...roots].some(r=>r.isConnected&&(r===n||r.contains(n))))return false;
        if(text(n).length>100||forbidden.test(text(n)))return false;
        for(let p=n;p&&p!==document.body;p=p.parentElement)if(/^(?:publish|submit|delete)(?:-?button|-?btn)?$|payment|login|captcha/i.test(p.id)||p.matches('dialog,[role=dialog]')&&forbidden.test(text(p)))return false;
        if(desired(n))return true;
        if(goal.kind==='declaration'&&goal.desired==='不使用AI声明'&&aiOption(n)&&(n.querySelector('input:checked')||n.getAttribute('aria-checked')==='true'))return true;
        if(/^(高级设置|更多设置|展开设置|展开|更多|继续编辑|返回编辑|关闭|知道了|我知道了)$/.test(text(n)))return true;
        // Unfamiliar expansion widgets are allowed within the actual goal row.
        // Other radio/checkbox options (e.g. friends/public) are not.
        if(n.matches('label,[role=radio],[role=checkbox],[role=option]'))return false;
        if(n.matches('[role=combobox],[aria-haspopup],summary,[class*="selectBox"],[class*="select-box"]')||n.hasAttribute('aria-expanded'))return true;
        const dialog=n.closest('[role=dialog],dialog');
        if(/^(确定|保存|完成)$/.test(text(n))&&dialog&&roots.has(dialog)){
          const selected=[...dialog.querySelectorAll('input:checked,[aria-checked=true],[aria-selected=true]')];
          return selected.length===1&&desired(selected[0].closest('label')||selected[0]);
        }
        return false;
      };
      const hitAt=(x,y)=>{let n=document.elementFromPoint(x,y);if(!n||n.closest('iframe,canvas'))return null;for(let i=0;n&&n!==document.body&&i<6;n=n.parentElement,i++)if(n.matches(controls+',label')||typeof n.onclick==='function'||n.tabIndex>=0||desired(n)){return safe(n)?n:null;}return null;};
      const s={document,url:location.href,goal,roots,challenge,safe,hitAt,changed:false,used:false,observer:null,inputGuard:null,clicked:false,width:innerWidth,height:innerHeight,sx:scrollX,sy:scrollY};
      s.ready=()=>document===s.document&&location.href===s.url&&!s.changed&&!challenge()&&innerWidth===s.width&&innerHeight===s.height&&scrollX===s.sx&&scrollY===s.sy;
      return s;
    },{goal,portalAllowed});
    if(await state.evaluate(s=>s.challenge())){await dispose();return {human:true};}
    const screenshot=await page.screenshot({type:'png',scale:'css',timeout:5000,animations:'disabled',mask:[page.locator('input,textarea,[contenteditable],img,video,canvas,svg,object,embed,iframe,header,nav,aside,[data-sensitive],[data-matrix-coordinate-sensitive]')],maskColor:'#d9dfdf',style:'*{color:transparent!important;text-shadow:none!important;background-image:none!important}*::before,*::after{content:none!important}[data-matrix-coordinate-scope],[data-matrix-coordinate-scope] *{color:#20252b!important}'});
    if(screenshot.length>4*1024*1024)throw Error('visual_screenshot_too_large');
    const details=await state.evaluate(s=>{if(!s.ready())return null;const selection=[...new Set([...s.roots].flatMap(r=>[...r.querySelectorAll('input:checked,[aria-checked=true]')].map(n=>(n.closest('label')||n).textContent.trim())))].filter(t=>t.length<=100&&!/(?:1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(t)).slice(0,8);s.externalChange=()=>s.changed=true;for(const t of ['input','change','scroll','resize'])window.addEventListener(t,s.externalChange,true);s.observer=new MutationObserver(()=>s.changed=true);s.observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});return {viewport:{width:s.width,height:s.height},selection};});
    if(!details){await dispose();return {human:true};}
    const observation={token:randomUUID(),mode:'visual',coordinateMode:true,goal,...details,targets:[],actions:['click_at','scroll','revalidate','human',...(goal.kind==='media'?['retry_image_upload']:[])],screenshot:'data:image/png;base64,'+screenshot.toString('base64')};
    return {observation,dispose,async perform(action){
      if(page.isClosed()||page.url()!==url||!validVisualAction(action,observation))return false;
      const accepted=await state.evaluate((s,a)=>{
        if(s.used||!s.ready())return false;s.used=true;
        if(a.action==='click_at'){
          const n=s.hitAt(a.x,a.y);if(!n)return false;
          s.inputGuard=e=>{if(e.type==='submit'||!s.ready()||s.hitAt(a.x,a.y)!==n||!s.safe(n)||!e.composedPath().includes(n)){e.preventDefault();e.stopImmediatePropagation();}else if(e.type==='click')s.clicked=true;};
          for(const t of ['pointerdown','mousedown','mouseup','click','submit'])window.addEventListener(t,s.inputGuard,true);
          return true;
        }
        if(a.action==='scroll'){window.scrollBy(0,a.direction==='down'?500:-500);return true;}
        return ['revalidate','human','retry_image_upload'].includes(a.action);
      },action).catch(()=>false);
      if(!accepted||action.action!=='click_at')return !!accepted;
      try{
        await page.mouse.click(action.x,action.y);const clicked=await state.evaluate(s=>s.clicked).catch(()=>false);
        if(clicked){const previous=openedMenus.get(page);await previous?.document.dispose().catch(()=>{});const document=await state.evaluateHandle(s=>s.document);const next={url,goal:JSON.stringify(goal),at:Date.now(),document};openedMenus.set(page,next);page.once('close',()=>{void document.dispose().catch(()=>{});});}
        return clicked;
      }
      finally{await state.evaluate(s=>{for(const t of ['pointerdown','mousedown','mouseup','click','submit'])window.removeEventListener(t,s.inputGuard,true);s.inputGuard=null;}).catch(()=>{});}
    }};
  }catch(e){await dispose();throw e;}
}
