const fail=message=>Object.assign(new Error('知乎创作声明：'+message),{state:'needs_manual',status:409});
const ai=/^(?:(?:内容)?(?:包含|使用了?|由)?\s*(?:AI\s*(?:辅助创作|生成(?:内容)?)|人工智能生成)(?:\s*作者对内容负责)?|笔记含\s*AI\s*合成内容)$/i;
const none=/^(无声明|不声明|无|未声明|不包含\s*AI(?:\s*辅助创作)?|不使用\s*AI(?:\s*辅助创作)?)$/i;

// Locate the labelled row and its actual selector, not the static label/help icon.
async function declarationControl(page,labelNames){
  const previous=page.locator('[data-matrix-ai-trigger="true"]');
  if(await previous.count()===1 && await previous.isVisible())return previous;
  const found=await page.evaluate(labelNames=>{
    const visible=n=>Boolean(n.getClientRects().length)&&getComputedStyle(n).visibility!=='hidden';
    const compact=s=>s.replace(/[\s\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g,'').replace(/[：:*＊?？]/g,'');
    const roots=[...document.querySelectorAll('[data-matrix-publish-scope],.PublishPanel-content,[role="dialog"],.Popover-content')].filter(visible);
    const search=roots.length?roots:[document.body];
    const controls=new Set();
    const declaration=new RegExp('^(?:'+labelNames.join('|')+')(?:（选填）|[(]选填[)]|选填)?'+String.fromCharCode(36));
    for(const root of search)for(const label of root.querySelectorAll('span,label,div,button')){
      if(!visible(label)||label.closest('[contenteditable="true"]')||!declaration.test(compact(label.textContent)))continue;
      if([...label.children].some(c=>declaration.test(compact(c.textContent))))continue;
      const own=label.closest('button,[role="combobox"],[role="button"],[aria-haspopup],.Select-button,[class*="select-trigger"],[class*="select-button"],[class*="dropdown-trigger"]');
      if(own&&visible(own)){controls.add(own);continue;}
      if(compact(label.textContent)==='添加内容类型声明'){controls.add(label);continue;}
      for(let row=label.parentElement,depth=0;row&&row!==document.body&&depth<5;row=row.parentElement,depth++){
        if(row.querySelector('[contenteditable="true"],textarea'))break;
        const raw=[...row.querySelectorAll('select,button,[role="combobox"],[role="button"],[aria-haspopup],input[readonly],.Select-button,[class*="select-trigger"],[class*="select-button"]')].filter(n=>visible(n)&& (n.tagName==='SELECT'||n.matches('input[readonly]')||compact(n.textContent)) && !/帮助|说明/.test(n.getAttribute('aria-label')||n.getAttribute('title')||'') && !/^(发布|发布文章|确认发布)$/.test(compact(n.textContent)) && (n.tagName==='SELECT'||n.tagName==='BUTTON'||n.getAttribute('role')==='combobox'||n.hasAttribute('aria-haspopup')||/声明|选择|AI|^无$/.test(n.textContent)||n===label));
        const candidates=raw.filter(n=>!raw.some(o=>o!==n&&o.contains(n)));
        if(candidates.length===1){controls.add(candidates[0]);break;}
        if(candidates.length>1)break;
        // Some versions render the current choice as a clickable span with no role.
        const values=[...row.querySelectorAll('span,div,a')].filter(n=>visible(n)&&n!==label&&!n.contains(label)&&/^(无声明|未声明|不声明|请选择(?:创作声明)?|包含\s*AI\s*辅助创作(?:\s*作者对内容负责)?|笔记含\s*AI\s*合成内容)$/.test(n.textContent.trim())&&!Array.from(n.children).some(c=>c.textContent.trim()===n.textContent.trim()));
        if(values.length===1){controls.add(values[0]);break;}
      }
    }
    if(!controls.size){
      // A single trigger may replace the words “创作声明” with the chosen value.
      for(const root of search)for(const n of root.querySelectorAll('button,[role="combobox"],[role="button"],[aria-haspopup],.Select-button,span,div')){
        if(!visible(n)||n.closest('[contenteditable="true"],[role="option"],[role="menuitem"],[role="listbox"],[role="menu"],li')||! /^(包含AI辅助创作(?:作者对内容负责)?|AI辅助创作|无声明|不声明|未声明|笔记含AI合成内容)$/.test(compact(n.textContent))||[...n.children].some(c=>compact(c.textContent)===compact(n.textContent)))continue;
        controls.add(n.closest('button,[role="combobox"],[aria-haspopup],.Select-button,[class*="select-trigger"],[class*="select-button"]')||n);
      }
    }
    document.querySelectorAll('[data-matrix-ai-trigger]').forEach(n=>n.removeAttribute('data-matrix-ai-trigger'));
    if(controls.size!==1)return {count:controls.size};
    const control=[...controls][0];control.setAttribute('data-matrix-ai-trigger','true');
    return {count:1};
  },labelNames);
  if(found.count!==1)return null;
  return page.locator('[data-matrix-ai-trigger="true"]');
}

async function currentChoice(control,labelNames){
  return control.evaluate((n,labels)=>{
    if(n.tagName==='SELECT')return n.selectedOptions[0]?.textContent?.trim()||'';
    let value=(n.getAttribute('aria-valuetext')||n.value||n.innerText||n.textContent||'').replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g,'');if(labels.some(l=>l.startsWith('添加')&&value.trim()===l))return '未选择';for(const label of labels)value=value.replaceAll(label,'');return value.replace(/[：:*＊]/g,'').trim();
  },labelNames);
}
function choiceState(value){
  if(ai.test(value))return true;
  if(none.test(value)||/^(请选择(?:创作声明)?|未设置|未选择)$/.test(value))return false;
  // Keep a known non-AI declaration; don't erase unrelated content declarations.
  if(/^(包含虚构(?:演绎)?内容|包含个人观点|个人观点[，,]?仅供参考|包含剧透|虚构演绎[，,]?仅供娱乐|包含医疗建议|虚构创作|包含理财内容|内容包含营销广告)$/.test(value))return false;
  return null;
}

async function checkboxOption(page){
  let locator=page.getByRole('checkbox',{name:/AI\s*辅助创作|包含\s*AI\s*生成/i});
  if(await locator.count()===1)return locator;
  locator=page.locator('label:visible').filter({hasText:/AI\s*辅助创作|包含\s*AI\s*生成/i}).locator('input[type="checkbox"]');
  return await locator.count()===1?locator:null;
}

async function plainOption(page,wanted){
  const regex=wanted?ai:none;
  for(const role of ['option','menuitemradio','menuitem','radio']){
    const option=page.getByRole(role,{name:regex}).filter({visible:true});
    if(await option.count()===1)return option;
    if(await option.count()>1)throw fail('匹配到多个声明选项，未选择，已暂停。');
  }
  const marked=await page.evaluate(({pattern,flags})=>{
    const regex=new RegExp(pattern,flags),candidates=new Set();
    const visible=n=>Boolean(n.getClientRects().length)&&getComputedStyle(n).visibility!=='hidden';
    const text=n=>n.textContent.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g,'').trim();
    for(const n of document.querySelectorAll('span,div,li,label,button,a')){
      if(!visible(n)||n.closest('[contenteditable="true"],[data-matrix-ai-trigger]')||!regex.test(text(n)))continue;
      if([...n.children].some(c=>regex.test(text(c))))continue;
      candidates.add(n.closest('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="radio"],li,label,button')||n);
    }
    document.querySelectorAll('[data-matrix-ai-option]').forEach(n=>n.removeAttribute('data-matrix-ai-option'));
    if(candidates.size!==1)return candidates.size;
    [...candidates][0].setAttribute('data-matrix-ai-option','true');return 1;
  },{pattern:regex.source,flags:regex.flags});
  if(marked>1)throw fail('页面存在多个同名声明选项，已暂停。');
  return marked===1?page.locator('[data-matrix-ai-option="true"]'):null;
}

export async function applyDeclarationAi(page,wanted,{timeout=5000,labelNames=['创作声明','内容声明','添加创作声明']}={}){
  let control=await declarationControl(page,labelNames);
  const readyBy=Date.now()+Math.min(timeout,1500);
  while(!control && Date.now()<readyBy){
    if(await checkboxOption(page))return null;
    await new Promise(r=>setTimeout(r,100));control=await declarationControl(page,labelNames);
  }
  if(!control)return null; // Fall back to the direct checkbox variant.
  const old=await currentChoice(control,labelNames);
  if(choiceState(old)===wanted)return {state:'applied',checked:wanted,kind:'zhihu-declaration',value:old};
  if(await control.evaluate(n=>n.tagName==='SELECT')){
    const options=await control.locator('option').evaluateAll(ns=>ns.map(n=>({value:n.value,label:n.textContent.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g,'').trim(),disabled:n.disabled})));
    const matches=options.filter(o=>!o.disabled&&(wanted?ai:none).test(o.label));
    if(matches.length!==1)throw fail('原生下拉框中没有唯一匹配项。');
    await control.selectOption(matches[0].value,{timeout:5000});
  }else{
    // Don't close a menu already opened by the operator or a preceding prepare step.
    let option=await plainOption(page,wanted),checkbox=await checkboxOption(page);
    if(!option&&!checkbox)await control.click({timeout:5000});
    const end=Date.now()+timeout;
    while(Date.now()<end){
      checkbox=await checkboxOption(page);option=await plainOption(page,wanted);
      if(checkbox||option)break;
      await new Promise(r=>setTimeout(r,150));
    }
    if(checkbox){
      if(await checkbox.isChecked({timeout:3000})!==wanted){
        if(!await checkbox.isEnabled({timeout:3000}))throw fail('AI 声明选项被平台禁用，无法设置。');
        if(await checkbox.isVisible())await checkbox.setChecked(wanted,{timeout:5000});
        else {const label=page.locator('label:visible').filter({has:checkbox});if(await label.count()!==1)throw fail('AI 声明关联标签不唯一。');await label.click({timeout:5000});}
      }
      if(await checkbox.isChecked({timeout:3000})!==wanted)throw fail('声明选项未切换到指定状态。');
      // Some checkbox menus require an explicit save within the declaration popup.
      const dialogs=page.locator('[role="listbox"]:visible,[role="menu"]:visible,[data-matrix-declaration-menu]:visible').filter({has:checkbox});
      if(await dialogs.count()===1){const done=dialogs.getByRole('button',{name:/^(确定|保存|完成)$/});if(await done.count()===1)await done.click({timeout:3000});}
    }else if(option)await option.click({timeout:5000});
    else if(!wanted){
      const selected=await plainOption(page,true);
      if(!selected||!await selected.evaluate(n=>n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-checked')==='true'||n.classList.contains('selected')||n.classList.contains('is-selected')))throw fail('没有找到明确的取消声明入口，未修改其他声明。');
      await selected.click({timeout:5000});
    }
    else throw fail(wanted?'展开后未找到“包含 AI 辅助创作”选项。':'展开后未找到取消 AI 的选项（无声明/不声明）。');
  }
  const end=Date.now()+timeout;
  while(Date.now()<end){
    control=await declarationControl(page,labelNames);
    if(control){const value=await currentChoice(control,labelNames);if(choiceState(value)===wanted)return {state:'applied',checked:wanted,kind:'zhihu-declaration',value};}
    await new Promise(r=>setTimeout(r,150));
  }
  throw fail('已选择声明，但未能从当前选项读回一致状态，未提交。');
}
export const applyZhihuAi=(page,wanted,options)=>applyDeclarationAi(page,wanted,options);
