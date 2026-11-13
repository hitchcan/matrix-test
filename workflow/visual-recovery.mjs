import {randomUUID} from 'node:crypto';
import {observeCoordinateRecovery} from './coordinate-recovery.mjs';

// Browser-only capability. The model selects retained controls, never arbitrary
// coordinates, selectors, URLs, keyboard shortcuts, scripts or file paths.
export async function observeVisualRecovery(page,allowedHosts,editor=null) {
  if(editor?.coordinateGoal)return observeCoordinateRecovery(page,allowedHosts,editor);
  if(page.isClosed())return {human:true};
  const url=page.url();
  if(!allowedHosts.some(host=>new URL(url).origin==='https://'+host))return {human:true};
  const context=page.context();
  const closePopup=popup=>{void popup.close().catch(()=>{});};
  const navigationGuard=async route=>{
    const request=route.request();
    // Visual controls may repair local UI state only. Uploads, autosave and any
    // final publishing write must return to the standard, checked workflow.
    try {
      if(request.frame().page()===page&&!['GET','HEAD','OPTIONS'].includes(request.method()))return route.abort();
    }catch{return route.abort();}
    if(request.isNavigationRequest()) {
      try {if(request.frame()===page.mainFrame()||await request.frame().page().opener()===page)return route.abort();}catch{return route.abort();}
    }
    return route.fallback();
  };
  await context.route('**/*',navigationGuard);page.on('popup',closePopup);
  const handle=await page.evaluateHandle(editor=>{
    const visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
    const challenge=()=>!!navigator.serviceWorker?.controller||[...document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]')].some(visible)||
      /短信验证|请扫码|请扫描二维码|请完成安全验证/.test(document.body.innerText);
    const safeLabel=/^(关闭|取消|知道了|我知道了|稍后再说|返回编辑|继续编辑|收起|重试|重新加载|close|cancel|retry|dismiss)$/i;
    const forbidden=/发布|提交|发送|删除|付款|支付|转账|授权|权限|登录|退出|验证|扫码|声明|审核|确认/;
    const label=n=>(n.getAttribute('aria-label')||n.getAttribute('title')||n.innerText||'').trim().replace(/\s+/g,'');
    const safe=n=>{
      if(!n?.isConnected||!visible(n)||n.disabled||n.getAttribute('aria-disabled')==='true'||n.closest('a,iframe,form')||!safeLabel.test(label(n)))return false;
      const r=n.getBoundingClientRect();if(r.width<1||r.height<1||r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight)return false;
      if(n.tagName==='BUTTON'&&n.type!=='button'&&n.form)return false;
      for(let p=n;p&&p!==document.body;p=p.parentElement){
        if(forbidden.test(p.getAttribute('aria-label')||'')||/publish|submit|delete|payment|login/i.test(p.id+' '+p.className))return false;
        if(p.matches('dialog,[role=dialog]')&&/确认发布|确认提交|删除|付款|授权|权限|短信|扫码|验证码/.test(p.innerText))return false;
      }
      return true;
    };
    const targets=[...document.querySelectorAll('button,[role=button]')].filter(safe).slice(0,24).map((node,index)=>{const r=node.getBoundingClientRect();return {node,id:'v'+index,label:label(node),rect:[r.x,r.y,r.width,r.height]};});
    const state={document,url:location.href,changed:false,used:false,targets,challenge,safe,editor,observer:null,guard:null,clicked:false};
    state.ready=()=>document===state.document&&location.href===state.url&&!state.changed&&!challenge();
    return state;
  },editor).catch(async error=>{page.off('popup',closePopup);await context.unroute('**/*',navigationGuard).catch(()=>{});throw error;});
  const dispose=async()=>{page.off('popup',closePopup);await context.unroute('**/*',navigationGuard).catch(()=>{});await handle.evaluate(s=>{s.observer?.disconnect();if(s.guard)for(const type of ['pointerdown','mousedown','mouseup','click','submit'])window.removeEventListener(type,s.guard,true);}).catch(()=>{});await handle.dispose().catch(()=>{});};
  try {
    if(await handle.evaluate(s=>s.challenge())){await dispose();return {human:true};}
    // Redact all page prose and media; reveal only the exact safe control labels.
    // This retains rendered geometry, popover layout and safe actionable controls
    // without shipping account identity, private drafts, credentials or images.
    const mask=page.locator('input,textarea,[contenteditable],img,video,canvas,svg,object,embed,iframe,header,nav,aside,[data-sensitive]');
    const screenshot=await page.screenshot({type:'png',timeout:5000,animations:'disabled',mask:[mask],maskColor:'#d9dfdf',
      style:'*{color:transparent!important;text-shadow:none!important;background-image:none!important}*::before,*::after{content:none!important}button,[role=button]{outline:1px solid #789!important}'});
    if(screenshot.length>4*1024*1024)throw Error('visual_screenshot_too_large');
    // Build only safe, bounded metadata and start fencing after screenshot CSS.
    const targets=await handle.evaluate(s=>{
      if(!s.ready())return null;
      if(s.targets.some(t=>{const r=t.node.getBoundingClientRect();return !s.safe(t.node)||[r.x,r.y,r.width,r.height].some((v,i)=>Math.abs(v-t.rect[i])>1);} ))return null;
      const result=s.targets.filter(t=>s.safe(t.node)).map(t=>{const r=t.node.getBoundingClientRect();return {id:t.id,label:t.label,x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};});
      s.observer=new MutationObserver(()=>{s.changed=true;});s.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      return result;
    });
    if(!targets){await dispose();return {human:true};}
    const token=randomUUID();
    const observation={token,mode:'visual',actions:['click','scroll','restore_title','revalidate','human',...(editor?.failureCode==='image_upload_failed'?['retry_image_upload']:[])],
      targets,screenshot:'data:image/png;base64,'+screenshot.toString('base64')};
    return {observation,
      async perform(action) {
        if(page.isClosed()||page.url()!==url||!action||action.token!==token)return false;
        const keys=action.action==='click'?['action','token','targetId']:action.action==='scroll'?['action','token','direction']:['action','token'];
        if(Object.keys(action).length!==keys.length||keys.some(k=>typeof action[k]!=='string')||!observation.actions.includes(action.action))return false;
        const reserved=await handle.evaluate((s,action)=>{
          if(s.used||!s.ready())return false;s.used=true;
          if(action.action==='click') {
            const target=s.targets.find(t=>t.id===action.targetId);
            if(!target||!s.safe(target.node))return false;
            const r=target.node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            if(!hit||!(target.node===hit||target.node.contains(hit)))return false;
            s.guard=e=>{
              if(e.type==='submit'||!s.ready()||!s.safe(target.node)||!e.composedPath().includes(target.node)){e.preventDefault();e.stopImmediatePropagation();return;}
              if(e.type==='click')s.clicked=true;
            };
            for(const type of ['pointerdown','mousedown','mouseup','click','submit'])window.addEventListener(type,s.guard,true);
            return {x:r.x+r.width/2,y:r.y+r.height/2};
          }
          if(action.action==='restore_title') {
            const editor=s.editor;if(!editor?.selector||!editor.title||location.origin+location.pathname!==editor.url)return false;
            const nodes=[...document.querySelectorAll(editor.selector)].filter(n=>n.getClientRects().length);
            const n=nodes[0];if(nodes.length!==1||!(n instanceof HTMLTextAreaElement||(n instanceof HTMLInputElement&&n.type==='text'))||n.value||n.disabled||n.readOnly)return false;
            Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,editor.title);
            n.dispatchEvent(new Event('input',{bubbles:true}));return true;
          }
          if(action.action==='scroll') {if(!['up','down'].includes(action.direction))return false;window.scrollBy(0,action.direction==='down'?500:-500);return true;}
          return ['revalidate','human'].includes(action.action)||(action.action==='retry_image_upload'&&s.editor?.failureCode==='image_upload_failed');
        },action).catch(()=>false);
        if(!reserved)return false;
        if(action.action!=='click')return reserved===true;
        try {await page.mouse.click(reserved.x,reserved.y);return await handle.evaluate(s=>s.clicked).catch(()=>false);}
        finally {await handle.evaluate(s=>{for(const type of ['pointerdown','mousedown','mouseup','click','submit'])window.removeEventListener(type,s.guard,true);s.guard=null;}).catch(()=>{});}
      },dispose};
  } catch(error){await dispose();throw error;}
}
