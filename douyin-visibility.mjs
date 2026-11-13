const fail=message=>Object.assign(Error('抖音：'+message),{state:'needs_manual',status:409,code:'visibility_unconfirmed'});
const names={private:/^\s*(?:仅自己可见|私密(?:[：:,，\s]*仅自己可见)?|仅自己)\s*$/,public:/^\s*(?:公开(?:[：:,，\s]*所有人可见)?|所有人可见)\s*$/};
const marker='data-matrix-douyin-visibility';
async function controls(page,rule){
  if(rule.visibility?.selector)return page.locator(rule.visibility.selector).filter({visible:true});
  await page.evaluate(marker=>{
    document.querySelectorAll('['+marker+']').forEach(n=>n.removeAttribute(marker));
    const visible=n=>!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
    const found=new Set();
    for(const label of document.querySelectorAll('label,span,div,h3,h4')){
      if(!visible(label)||label.closest('[contenteditable],textarea')||!/^(谁可以看|可见范围|观看权限|发布权限|权限设置)[：:*＊\s]*$/.test(label.textContent.trim())||[...label.children].some(n=>/^(谁可以看|可见范围|观看权限|发布权限|权限设置)[：:*＊\s]*$/.test(n.textContent.trim())))continue;
      for(let row=label.parentElement,depth=0;row&&row!==document.body&&depth<3;row=row.parentElement,depth++){
        if(row.querySelector('[contenteditable],textarea'))break;
        if(row.querySelector('input[type="radio"]')&&!row.querySelector('select,[role="combobox"]')){found.add(row);break;}
        // The actual creator editor implements its visibility radio group with
        // hidden checkbox inputs and label[data-checked], not native radios.
        const checks=[...row.querySelectorAll('input[type="checkbox"]')];
        if(checks.length>=2&&checks.every(n=>n.closest('label')&&/^(公开|所有人可见|好友可见|仅自己可见|私密)$/.test(n.closest('label').textContent.trim()))){found.add(row);break;}
        let cs=[...row.querySelectorAll('select,[role="combobox"],[role="radiogroup"],[aria-haspopup],button,input[readonly]')].filter(visible);
        cs=cs.filter(n=>!cs.some(other=>other!==n&&other.contains(n)));
        if(!cs.length)cs=[...row.querySelectorAll('span,div')].filter(n=>visible(n)&&/^(公开|所有人可见|私密|仅自己可见|私密[：:，,\s]*仅自己可见)$/.test(n.textContent.trim())&&![...n.children].some(c=>c.textContent.trim()===n.textContent.trim())).map(n=>n.closest('[class*="selectBox"],[class*="select-box"]')||n);
        if(cs.length===1){found.add(cs[0]);break;}if(cs.length>1)break;
      }
    }
    for(const n of found)n.setAttribute(marker,'true');
  },marker);
  return page.locator('['+marker+'="true"]').filter({visible:true});
}
async function value(control){
  return control.evaluate(n=>{
    if(n.tagName==='SELECT')return n.selectedOptions[0]?.textContent?.trim()||'';
    if(n.querySelector('input[type="radio"],input[type="checkbox"]')){
      const inputs=[...n.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
      // Read current DOM properties; saved HTML checked attributes can be stale.
      const selected=inputs.filter(i=>i.checked);
      if(selected.length!==1||inputs.some(i=>{const state=i.closest('label')?.getAttribute('data-checked');return state!==null&&state!==undefined&&state!==String(i.checked);}))return '';
      return (selected[0].closest('label')?.textContent||'').trim();
    }
    if(n.getAttribute('role')==='radiogroup'){const selected=n.querySelectorAll('[role="radio"][aria-checked="true"]');return selected.length===1?(selected[0].textContent||'').trim():'';}
    return (n.getAttribute('aria-valuetext')||n.value||n.innerText||'').trim();
  });
}
// Preparation may select the requested value. Final submission only reads it back.
export async function douyinVisibility(page,wanted,rule={}, {verifyOnly=false}={}){
  if(wanted==null)return {state:'unchanged',value:null};
  if(!names[wanted])throw fail('可见范围无效。');
  let control=await controls(page,rule);
  if(await control.count()===0&&!verifyOnly){
    const advanced=page.getByText('高级设置',{exact:true}).filter({visible:true});
    if(await advanced.count()===1&&await advanced.getAttribute('aria-expanded')!=='true')await advanced.click({timeout:5000});
    control=await controls(page,rule);
  }
  if(await control.count()!==1)throw fail('无法唯一定位视频可见范围，尚未提交。');
  const matches=async()=>{const latest=await controls(page,rule);if(await latest.count()!==1)return false;control=latest;return names[wanted].test(await value(control));};
  if(await matches())return {state:'verified',value:wanted};
  if(verifyOnly)throw fail('视频可见范围与任务不一致，已暂停提交。');
  if(await control.evaluate(n=>n.tagName==='SELECT')){
    const opts=await control.locator('option').evaluateAll(ns=>ns.filter(n=>!n.disabled).map(n=>({label:n.textContent.trim(),value:n.value})));
    const selected=opts.filter(o=>names[wanted].test(o.label));
    if(selected.length!==1)throw fail('没有唯一的目标可见范围选项。');
    await control.selectOption(selected[0].value);
  }else{
    const radio=control.getByRole('radio',{name:names[wanted],exact:true});
    const radioLabel=control.locator('label').filter({hasText:names[wanted]}).filter({has:page.locator('input[type="radio"],input[type="checkbox"]')}).filter({visible:true});
    if(await radioLabel.count()===1)await radioLabel.click({timeout:5000});
    else if(await radio.count()===1){
      if(await radio.isVisible())await radio.check({timeout:5000});
      else{const label=control.locator('label').filter({has:radio}).filter({visible:true});if(await label.count()!==1)throw fail('可见范围单选标签不唯一。');await label.click({timeout:5000});}
    }
    else {
      await control.click({timeout:5000});
      const options=page.getByText(names[wanted],{exact:true}).filter({visible:true}).filter({hasNot:page.locator('[contenteditable],textarea')});
      try{await options.first().waitFor({state:'visible',timeout:5000});}catch{throw fail('未找到可见范围菜单，尚未提交。');}
      const count=await options.evaluateAll((ns,marker)=>{
        document.querySelectorAll('[data-matrix-douyin-visibility-option]').forEach(n=>n.removeAttribute('data-matrix-douyin-visibility-option'));
        const valid=ns.filter(n=>!n.closest('[contenteditable],textarea,['+marker+']')&&![...n.children].some(c=>c.textContent.trim()===n.textContent.trim()));
        if(valid.length===1)valid[0].setAttribute('data-matrix-douyin-visibility-option','true');return valid.length;
      },marker);
      if(count!==1)throw fail('目标可见范围菜单选项不唯一。');
      await page.locator('[data-matrix-douyin-visibility-option="true"]').click({timeout:5000});
    }
  }
  const end=Date.now()+3000;
  do{if(await matches())return {state:'verified',value:wanted};await page.waitForTimeout(100);}while(Date.now()<end);
  throw fail('无法确认所选视频可见范围，已暂停提交。');
}
