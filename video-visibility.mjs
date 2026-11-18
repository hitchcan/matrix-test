const fail=message=>Object.assign(Error(message),{state:'needs_manual',status:409});
export function visibilityIssues(settings){
  if(settings==null)return [];
  if(typeof settings!=='object'||Array.isArray(settings)||Object.entries(settings).some(([p,v])=>!['bilibili','kuaishou','channels'].includes(p)||!['public','private'].includes(v)))return ['视频可见范围无效'];
  return [];
}
export async function videoVisibility(page,platform,wanted,{verifyOnly=false}={}){
  if(wanted==null)return {state:'unchanged',value:null};
  if(!['bilibili','kuaishou'].includes(platform)||!['private','public'].includes(wanted))throw fail('视频可见范围无效');
  const bili=platform==='bilibili',name=wanted==='private'?'仅自己可见':bili?'公开可见':'所有人可见';
  let row=bili?page.locator('.vu-only-self').filter({visible:true}):page.locator('[class*="_edit-form-item_"]').filter({has:page.locator('label').filter({hasText:/^查看权限$/})}).filter({visible:true});
  if(bili&&await row.count()===0){
    const more=page.getByText(/^更多设置(?:\s|（|\().*|^更多设置$/).filter({visible:true});
    if(await more.count()!==1)throw fail('B站更多设置入口不唯一，无法核对可见范围');
    await more.click();await row.first().waitFor({state:'visible',timeout:5000});
  }
  if(await row.count()!==1)throw fail('可见范围控件缺失或不唯一');
  const read=async()=>{
    if(bili){const checked=row.locator('.check-radio-v2-container').filter({has:page.locator('.check-radio-v2-box-checked')});return await checked.count()===1?(await checked.locator('.check-radio-v2-name').innerText()).trim():'';}
    const checked=row.locator('input[type="radio"]:checked');return await checked.count()===1?(await checked.locator('xpath=ancestor::label').innerText()).trim():'';
  };
  if(await read()!==name){
    if(verifyOnly)throw fail('视频可见范围已变化，已阻断提交，请恢复任务指定范围');
    const target=bili?row.locator('.check-radio-v2-container').filter({has:page.locator('.check-radio-v2-name').filter({hasText:new RegExp('^'+name+'$')})}):row.locator('label').filter({hasText:new RegExp('^'+name+'$')});
    if(await target.count()!==1)throw fail('可见范围目标选项不唯一');await target.click();
  }
  const end=Date.now()+3000;do{if(await read()===name)return {state:'verified',value:wanted};await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);
  throw fail('可见范围设置未读回一致状态，已暂停提交');
}
