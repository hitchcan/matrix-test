import {randomUUID} from 'node:crypto';

// Observation retains a handle in this process. Only capability names and a
// one-use nonce are sent to the planner, never page text, URLs or field values.
export async function observeRecovery(page, allowedHosts, editor = null) {
  const url = page.url();
  if (!allowedHosts.some(host=>new URL(url).origin==='https://'+host)) return {human:true};
  const handle = await page.evaluateHandle(editor=>{
    const visible = element=>!!element.getClientRects().length;
    const challenge = [...document.querySelectorAll('input[autocomplete="one-time-code"],input[type=password],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]')].some(visible)
      || /短信验证|请扫码|请扫描二维码|请完成安全验证/.test(document.body.innerText);
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter(visible);
    const dialog = dialogs.length===1 && !dialogs[0].querySelector('form,input,textarea') &&
      /使用提示|操作指南|新手引导/.test(dialogs[0].innerText) &&
      !/验证|提交|发布|声明|审核/.test(dialogs[0].innerText) ? dialogs[0] : null;
    let titleField=null;
    if (!challenge && editor?.title && editor.selector && location.origin+location.pathname===editor.url) {
      const fields=[...document.querySelectorAll(editor.selector)].filter(visible);
      const field=fields[0];
      if (fields.length===1 && ((field instanceof HTMLInputElement && field.type==='text') || field instanceof HTMLTextAreaElement) &&
          !field.disabled && !field.readOnly && field.value==='') titleField=field;
    }
    const state={challenge,dialog,titleField,title:editor?.title,imageFailure:editor?.failureCode==='image_upload_failed',document,stale:false};
    state.observer=new MutationObserver(()=>{state.stale=true;});
    state.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    return state;
  },editor);
  const dispose=async()=>{await handle.evaluate(s=>s.observer.disconnect()).catch(()=>{});await handle.dispose().catch(()=>{});};
  try {
    const flags=await handle.evaluate(s=>({challenge:s.challenge,dialog:!!s.dialog,title:!!s.titleField,imageFailure:s.imageFailure}));
    if(flags.challenge) {await dispose();return {human:true};}
    const token=randomUUID();
    return {observation:{token,...(flags.imageFailure?{failureCode:'image_upload_failed'}:{}),actions:[...(flags.dialog?['dismiss_tip']:[]),...(flags.title?['restore_title']:[]),...(flags.imageFailure?['retry_image_upload']:[]),'revalidate','human']},
      async perform(action) {
        if(page.isClosed() || page.url()!==url) return false;
        return handle.evaluate((s,action)=>{
          if(document!==s.document || s.stale || !['dismiss_tip','restore_title','retry_image_upload','revalidate'].includes(action)) return false;
          if(action==='retry_image_upload'&&!s.imageFailure)return false;
          s.stale=true;
          if (/短信验证|请扫码|请扫描二维码|请完成安全验证/.test(document.body.innerText) ||
              [...document.querySelectorAll('input[autocomplete="one-time-code"],input[type=password],iframe[src*="captcha"],[class*="captcha"],[id*="captcha"]')].some(e=>e.getClientRects().length)) return false;
          if(action==='restore_title') {
            const field=s.titleField;
            if (!field?.isConnected || field.disabled || field.readOnly || field.value!=='' || !field.getClientRects().length) return false;
            const proto=field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(field,s.title);
            field.dispatchEvent(new Event('input',{bubbles:true}));
            return field.value===s.title;
          }
          if(action==='dismiss_tip') {
            if (!s.dialog?.isConnected || !s.dialog.open || s.dialog.querySelector('form,input,textarea') ||
                !/使用提示|操作指南|新手引导/.test(s.dialog.innerText) || /验证|提交|发布|声明|审核/.test(s.dialog.innerText)) return false;
            HTMLDialogElement.prototype.close.call(s.dialog);
          }
          return true;
        },action).catch(()=>false);
      },dispose};
  } catch(error) {await dispose();throw error;}
}
