const ai=/^笔记含\s*AI\s*合成内容$/i;
const empty=/^(添加内容类型声明|内容类型声明|请选择|无声明|未声明|不声明)$/;
const other=/^(虚构演绎[，,]?仅供娱乐|内容包含营销广告)$/;
const fail=message=>Object.assign(new Error('小红书内容类型声明：'+message),{state:'needs_manual',status:409});
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function trigger(page){
 const count=await page.evaluate(()=>{
  const clean=s=>s.replace(/[\u200b-\u200f\ufeff]/g,'').trim();
  const names=/^(添加内容类型声明|内容类型声明|无声明|未声明|不声明|笔记含\s*AI\s*合成内容|虚构演绎[，,]?仅供娱乐|内容包含营销广告)$/;
  const candidates=[...document.querySelectorAll('.d-select-main')].filter(n=>{
   if(!n.getClientRects().length||n.closest('[contenteditable="true"],.d-option,[role="option"],[role="listbox"]'))return false;
   const value=n.querySelector('.d-select-description'),placeholder=n.querySelector('.d-select-placeholder');
   return names.test(clean(value?.textContent||placeholder?.textContent||''));
  });
  document.querySelectorAll('[data-matrix-xhs-declaration]').forEach(n=>n.removeAttribute('data-matrix-xhs-declaration'));
  if(candidates.length===1)candidates[0].setAttribute('data-matrix-xhs-declaration','true');return candidates.length;
 });
 if(count>1)throw fail('存在多个内容类型声明选择框，未操作。');
 return count===1?page.locator('[data-matrix-xhs-declaration="true"]'):null;
}
async function valueOf(control){
 return control.evaluate(n=>{
  const clean=s=>s.replace(/[\u200b-\u200f\ufeff]/g,'').trim();
  const selected=n.querySelector('.d-select-description');
  return clean(selected?.textContent||n.querySelector('.d-select-placeholder')?.textContent||'');
 });
}
const stateOf=value=>ai.test(value)?true:empty.test(value)||other.test(value)?false:null;

async function option(page,wanted){
 const roots=page.locator('.d-option,[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]');
 const count=await roots.evaluateAll((nodes,wanted)=>{
  const visible=n=>{for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return Boolean(n.getClientRects().length);};
  const candidates=nodes.filter(n=>visible(n)&&!n.closest('[contenteditable="true"],.d-select-main,.permission-info'));
  const matching=candidates.filter(n=>{
   const text=(n.querySelector('.d-option-name')?.textContent||n.textContent||'').replace(/[\u200b-\u200f\ufeff]/g,'').trim();
   return (wanted?/^笔记含\s*AI\s*合成内容$/i:/^(无声明|未声明|不声明|添加内容类型声明)$/).test(text);
  }).filter(n=>!candidates.some(o=>o!==n&&o.contains(n)));
  document.querySelectorAll('[data-matrix-xhs-declaration-option]').forEach(n=>n.removeAttribute('data-matrix-xhs-declaration-option'));
  if(matching.length===1)matching[0].setAttribute('data-matrix-xhs-declaration-option','true');return matching.length;
 },wanted);
 if(count>1)throw fail('声明菜单有多个匹配项，未选择。');
 return count===1?page.locator('[data-matrix-xhs-declaration-option="true"]'):null;
}

export async function applyXhsAi(page,wanted,{timeout=5000}={}){
 if(wanted===null)return {state:'unchanged',checked:null};
 let control=await trigger(page);if(!control)return null;
 let value=await valueOf(control);
 if(stateOf(value)===wanted)return {state:'applied',checked:wanted,kind:'xhs-select',value,evidence:'已从小红书内容类型声明选择框核验：'+value};
 let choice=await option(page,wanted);
 if(!choice)await control.click({timeout:5000});
 const end=Date.now()+timeout;
 do{choice=await option(page,wanted);if(choice)break;await delay(100);}while(Date.now()<end);
 if(!choice&&!wanted){
  const selected=await option(page,true);
  if(selected&&await selected.evaluate(n=>n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-checked')==='true'||n.classList.contains('selected')||n.classList.contains('is-selected')||n.classList.contains('--selected')))choice=selected;
 }
 if(!choice)throw fail(wanted?'展开后未找到唯一的“笔记含AI合成内容”菜单项。':'未找到明确的取消声明入口，请在后台取消后再确认。');
 await choice.click({timeout:5000});
 const ready=Date.now()+timeout;
 do{
  control=await trigger(page);
  if(control){value=await valueOf(control);if(stateOf(value)===wanted)return {state:'applied',checked:wanted,kind:'xhs-select',value,evidence:'已从小红书内容类型声明选择框核验：'+value};}
  await delay(100);
 }while(Date.now()<ready);
 throw fail('选择框当前值仍与任务选项不一致，未执行发布；请检查是否还有声明确认弹窗。');
}
