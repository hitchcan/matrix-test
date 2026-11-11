// Fallback for editor variants without a usable declaration control.
// Never pretend an unknown platform declaration was changed.
export async function zhihuWithoutAi(page,{required=true}={}){
  const state=await page.evaluate(()=>{
    const ai=/^(?:包含\s*)?(?:AI\s*辅助创作|AI\s*生成(?:内容)?|人工智能生成)$/i;
    const none=/^(无声明|未声明|不声明|不包含\s*AI(?:\s*辅助创作)?)$/i;
    const visible=n=>{for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false;}return Boolean(n.getClientRects().length);};
    const controls=[...document.querySelectorAll('select,button,[role="combobox"],.Select-button,[data-matrix-ai-trigger]')].filter(n=>visible(n)&&!n.closest('[contenteditable="true"],[role="listbox"],[role="menu"]'));
    const values=controls.map(n=>(n.tagName==='SELECT'?n.selectedOptions[0]?.textContent:n.getAttribute('aria-valuetext')||n.innerText||'').trim());
    const checkboxes=[...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(n=>{
      const name=n.getAttribute('aria-label')||[...(n.labels||[])].map(l=>l.innerText).join(' ');
      return /AI\s*辅助创作|AI\s*生成|人工智能生成/i.test(name)&&(visible(n)||[...(n.labels||[])].some(visible));
    });
    if(values.some(v=>ai.test(v))||checkboxes.some(n=>n.checked||n.getAttribute('aria-checked')==='true'))return 'ai';
    return values.some(v=>none.test(v))||checkboxes.some(n=>n.checked===false||n.getAttribute('aria-checked')==='false')?'none':'unknown';
  });
  if(state==='ai'){
    const message='知乎后台已显示原有 AI 创作声明。当前任务选择不勾选，请在后台手动取消该声明后再确认；请核对当前页面的声明控件。';
    if(required)throw Object.assign(new Error(message),{state:'needs_manual',status:409});
    return {state:'pending',checked:null,kind:'zhihu-no-ai',evidence:message};
  }
  return {state:'not_requested',checked:state==='none'?false:null,kind:'zhihu-no-ai',evidence:state==='none'?'未请求添加 AI 声明；后台当前显示无声明或未勾选，工具未操作声明菜单。':'未请求添加 AI 声明；工具未操作声明菜单，后台声明状态尚未核验。'};
}
