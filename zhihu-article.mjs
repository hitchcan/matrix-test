const error=message=>Object.assign(new Error(message),{state:'needs_manual',status:409});
export function isZhihuEditor(url){const u=new URL(url);return u.protocol==='https:'&&u.hostname==='zhuanlan.zhihu.com'&&(/^\/write\/?$/.test(u.pathname)||/^\/p\/\d+\/edit\/?$/.test(u.pathname));}
export function zhihuArticleUrl(url){const u=new URL(url);return u.protocol==='https:'&&u.hostname==='zhuanlan.zhihu.com'&&/^\/p\/\d+\/?$/.test(u.pathname)?u.origin+u.pathname:null;}

async function existingPanel(page,rule){
  // Current editor renders settings inline and the final button in a sibling
  // fixed footer. Finding this section must never click that final button.
  const inline=await page.evaluate(()=>{
    const sections=new Set();
    for(const n of document.querySelectorAll('label,span,div')){
      if(!n.getClientRects().length||n.closest('[contenteditable="true"]')||n.textContent.replace(/[\s：:?？\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g,'')!=='创作声明')continue;
      for(let p=n.parentElement;p&&p!==document.body;p=p.parentElement){
        if(p.querySelector('[contenteditable="true"],textarea'))break;
        if(['添加封面','投稿至问题','文章话题','发布设置'].filter(s=>p.textContent.includes(s)).length>=2){sections.add(p);break;}
      }
    }
    document.querySelectorAll('[data-matrix-inline-settings]').forEach(n=>n.removeAttribute('data-matrix-inline-settings'));
    if(sections.size!==1)return false;const s=[...sections][0];s.setAttribute('data-matrix-inline-settings','true');s.setAttribute('data-matrix-publish-scope','true');return true;
  });
  if(inline)return page.locator('[data-matrix-inline-settings="true"]');
  const final=page.getByRole('button',{name:/^(发布|发布文章|确认发布)$/});
  for(const panel of [page.locator(rule.panel || '.PublishPanel-content').filter({visible:true}),page.getByRole('dialog').filter({has:final}),page.locator('.Popover-content:visible, [data-popper-placement]:visible').filter({has:final})]){
    if(await panel.count()===1)return panel;
  }
  // Some Zhihu versions use generated classes without dialog roles. Find the smallest
  // settings container around a final button; never use the editor or whole page as scope.
  const located=await page.evaluate(()=>{
    const panels=new Set();
    for(const button of document.querySelectorAll('button,[role="button"]')){
      if(!button.getClientRects().length || !/^(发布|发布文章|确认发布)$/.test(button.textContent.replace(/\s+/g,'')))continue;
      for(let p=button.parentElement;p && p!==document.body;p=p.parentElement){
        if(p.querySelector('[contenteditable="true"],textarea'))break;
        if(/创作声明|内容声明|添加话题|发布设置|选择专栏|AI\s*辅助创作/.test(p.textContent)){panels.add(p);break;}
      }
    }
    document.querySelectorAll('[data-matrix-publish-scope]').forEach(n=>n.removeAttribute('data-matrix-publish-scope'));
    if(panels.size!==1)return false;
    [...panels][0].setAttribute('data-matrix-publish-scope','true');return true;
  });
  if(located)return page.locator('[data-matrix-publish-scope="true"]');
  return null;
}
export async function zhihuPanel(page,rule,{open=true,hooks={}}={}){
  let panel=await existingPanel(page,rule);
  if(panel)return panel;
  if(!open)throw error('知乎发布设置面板未显示，请重新打开发布设置。');
  let trigger=page.locator(rule.settingsTrigger || 'button.PublishPanel-triggerButton').filter({visible:true});
  let semantic=false;
  if(await trigger.count()!==1){
    trigger=page.getByRole('button',{name:/^(发布|下一步|发布设置)$/}).filter({visible:true});
    const end=Date.now()+8000;
    while(await trigger.count()===0 && Date.now()<end)await new Promise(r=>setTimeout(r,150));
    if(await trigger.count()!==1)throw error('未找到唯一的知乎发布入口（发布/下一步/发布设置），已暂停，未点击任何提交按钮。');
    semantic=true;
  }
  // An unfamiliar publish control might submit immediately. Persist uncertainty before clicking.
  if(semantic)hooks.onOpening?.();
  try{
    await trigger.click({timeout:10000});
    const end=Date.now()+10000;
    do{
      panel=await existingPanel(page,rule);
      if(panel){if(semantic)hooks.onOpened?.();return panel;}
      if(zhihuArticleUrl(page.url()))break;
      await new Promise(r=>setTimeout(r,150));
    }while(Date.now()<end);
  }catch(e){if(!semantic)throw e;}
  if(semantic)throw Object.assign(error('已操作知乎发布入口，但未确认打开设置面板。为防重复发布，请人工核对稿件结果。'),{state:'unknown'});
  throw error('知乎发布设置未打开，请检查页面校验或验证提示。');
}

export async function zhihuFinalButton(page,rule){
  const panel=await zhihuPanel(page,rule,{open:false});
  let button=rule.finalButton?panel.locator(rule.finalButton):panel.getByRole('button',{name:/^(发布|发布文章|确认发布)$/});
  if(!rule.finalButton&&await button.count()===0&&await panel.getAttribute('data-matrix-inline-settings')==='true')button=page.getByRole('button',{name:/^(发布|发布文章|确认发布)$/}).filter({visible:true});
  if(await button.count()!==1)throw error('知乎发布面板中的最终提交按钮不唯一。');
  const end=Date.now()+15000;
  do{if(await button.isEnabled({timeout:1000}))return button;await new Promise(r=>setTimeout(r,150));}while(Date.now()<end);
  throw error('知乎最终发布按钮持续不可用，请检查必填项或平台提示。');
}

export async function waitZhihuReceipt(page,rule){
  const end=Date.now()+(rule.resultTimeoutMs || 45000);
  while(Date.now()<end){
    const url=zhihuArticleUrl(page.url());
    if(url)return {id:new URL(url).pathname.split('/')[2],url,evidence:'最终提交后进入知乎文章详情页；审核及公开可见性仍待核验'};
    const success=rule.success?page.locator(rule.success):page.getByText(/^(发布成功|文章发布成功|已提交审核|发布成功，等待审核)$/);
    if(await success.filter({visible:true}).count())return {id:null,url:null,evidence:'知乎显示提交成功或已提交审核提示；公开状态尚未确认'};
    const alert=page.getByRole('alert').filter({hasText:/失败|错误|验证|不能为空|必填/});
    if(await alert.count())throw error('知乎提交后显示处理提示，结果待确认；请在后台核对，勿重复发布。');
    await new Promise(r=>setTimeout(r,250));
  }
  throw error('知乎最终提交后未取得确定回执，请核对稿件，勿重复发布。');
}
