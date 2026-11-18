const fail=message=>Object.assign(new Error('视频号：'+message),{state:'needs_manual',status:409});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export const channelsAdapterRevision='2026-11-17-selected-mark-tag-v2';
export function channelsText(content,kind){
  const value=content.versions?.channels?.[kind]||content[kind]||'';
  return kind==='title'?value.replace(/[^\p{L}\p{N}\s《》“”‘’：:+＋?？%％℃]/gu,' ').replace(/\s+/g,' ').trim():value;
}
export function channelsEditorUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='channels.weixin.qq.com'&&/^\/platform\/post\/create\/?$/.test(u.pathname);}catch{return false;}}
// Playwright locators pierce open Wujie shadow roots. If the platform instead
// renders in a same-origin frame, select only one official editor document.
export async function channelsScope(page,rule){
  if(!channelsEditorUrl(page.url()))throw fail('当前页面不是官方视频发布页。');
  if(await page.locator(rule.body).count())return page;
  const frames=page.frames().filter(f=>f!==page.mainFrame()&&/^https:\/\/channels\.weixin\.qq\.com\//.test(f.url()));
  const matches=[];for(const frame of frames)if(await frame.locator(rule.body).count())matches.push(frame);
  if(matches.length!==1)throw fail('尚未找到唯一视频编辑器，请检查登录、页面加载或验证提示。');
  return matches[0];
}
export async function channelsField(page,kind,rule){
  const end=Date.now()+(rule.editorTimeoutMs||180000);
  do{
    try{const scope=await channelsScope(page,rule),field=scope.locator(rule[kind]).filter({visible:true});if(await field.count()>1)throw fail('编辑字段不唯一。');if(await field.count()===1)return field;}catch(error){if(/不唯一|不是官方/.test(error.message))throw error;}
    await pause(200);
  }while(Date.now()<end);
  throw fail('视频描述或短标题编辑器未就绪。');
}
export async function channelsUpload(page,rule){
  await channelsField(page,'body',rule);
  const scope=await channelsScope(page,rule),input=scope.locator(rule.upload);
  await input.first().waitFor({state:'attached',timeout:30000});
  if(await input.count()!==1)throw fail('视频上传入口不唯一。');return input;
}
// Read the selected-value node, not the whole rendered dropdown text. The new
// saved page corroborates it with has-value and the orange is-selected option.
async function markTagState(control){
  return control.evaluate(n=>{
    const text=n=>n?.textContent?.replace(/[\u200b-\u200f\ufeff]/g,'').replace(/\s+/g,'').trim()||'';
    const values=[...n.querySelectorAll('.select-display .select-value')];
    const options=[...n.querySelectorAll('.mark-tag-option')];
    const selected=options.filter(n=>n.classList.contains('is-selected'));
    const value=values.length===1?text(values[0]):'';
    const selectedValue=selected.length===1?text(selected[0].querySelector('.option-main')):'';
    const hasValue=n.classList.contains('has-value');
    const consistent=hasValue?values.length===1&&!!value&&(!options.length||selected.length===1&&selectedValue===value):values.length===0&&selected.length===0;
    return {open:n.classList.contains('is-open'),value,hasValue,consistent,selectedCount:selected.length};
  });
}
export async function channelsAi(page,wanted,rule,{verifyOnly=false}={}){
  if(wanted===null)return {state:'unchanged',checked:null};
  let last=null;
  const nonAi=['无需标注','内容为虚构剧情，仅供娱乐','个人观点，仅供参考','内容包含营销广告','内容为自行拍摄','内容为转载'];
  try{
    const scope=await channelsScope(page,rule),control=scope.locator('.post-with-mark-tag .mark-tag-select').filter({visible:true});
    if(await control.count()!==1)throw fail('视频标注控件缺失或不唯一。');
    const read=async()=>{last=await markTagState(control);return last;};
    const stable=async()=>{const end=Date.now()+3000;do{const s=await read();if(s.consistent)return s;await pause(50);}while(Date.now()<end);throw fail('声明显示值与选中标记不一致。');};
    const before=await stable();
    if(before.value&&before.value!=='含AI生成内容'&&!nonAi.includes(before.value))throw fail('无法识别当前视频标注。');
    const target=wanted?'含AI生成内容':nonAi.includes(before.value)?before.value:'无需标注';
    if(verifyOnly){
      if(before.value!==target)throw fail('提交前声明与任务不一致，请先恢复所选声明；未打开或重选菜单。');
      if(before.open)throw fail('提交前声明菜单仍打开，请关闭后重新核验；未点击已选项。');
      return {state:'verified',checked:wanted,kind:'channels-mark-tag'};
    }
    let picked=false;
    if(before.value!==target){
      if(!before.open)await control.locator('.select-display').click();
      const options=control.locator('.mark-tag-options');await options.waitFor({state:'visible',timeout:5000});
      // Opening/loading the menu may restore its default selection. Re-read it
      // before any option click; selecting an orange option would cancel it.
      const opened=await stable();
      if(opened.value!==target){
        const option=control.locator('.mark-tag-option:not(.is-selected)').filter({has:scope.locator('.option-main').filter({hasText:new RegExp('^'+target+'$')})}).filter({visible:true});
        if(await option.count()!==1)throw fail('目标声明未处于唯一可选状态；未重复点击已选项。');
        await option.click({timeout:5000});picked=true;
      }
    }
    // A new selection closes itself. Only close an already-selected, open menu
    // once; after selecting an option, never click the toggle again.
    if(!picked){const s=await stable();if(s.value===target&&s.open)await control.locator('.select-display').click();}
    const end=Date.now()+5000;
    do{const s=await read();if(s.consistent&&s.value===target&&!s.open)return {state:'applied',checked:wanted,kind:'channels-mark-tag'};await pause(50);}while(Date.now()<end);
    throw fail('声明未完成选中并自动关闭；未再次打开或重复选择。');
  }catch(error){
    const value=last?.value==='含AI生成内容'||nonAi.includes(last?.value)?last.value:last?.hasValue?'未知已选值':'未选择';
    const details=last?`（当前=${value}，菜单=${last.open?'打开':'关闭'}，选中标记=${last.selectedCount}，状态一致=${last.consistent}）`:'';
    throw Object.assign(fail((error.state?error.message.replace(/^视频号：/,''):String(error.message).split('\n')[0].slice(0,180))+details),{code:'channels_declaration_state',noAutoRecovery:true});
  }
}
export const channelsDraft=content=>content?.type==='video'&&content?.publication?.videoVisibility?.channels==='private';
export async function channelsPublishButton(page,rule,content){
  const scope=await channelsScope(page,rule),immediate=scope.getByRole('radio',{name:'不定时',exact:true});
  if(await immediate.count()!==1||!await immediate.isChecked())throw fail('后台并非不定时发表，请人工核对；工具定时由本机调度。');
  const button=scope.getByRole('button',{name:channelsDraft(content)?'保存草稿':'发表',exact:true}).filter({visible:true});
  if(await button.count()!==1)throw fail('最终发表按钮缺失或不唯一。');
  if(!await button.isEnabled()||await button.evaluate(n=>n.classList.contains('weui-desktop-btn_disabled')||n.getAttribute('aria-disabled')==='true'))throw fail('发表按钮不可用，请检查上传完成状态及必填项。');
  return button;
}
export async function channelsSuccessVisible(page,content){
  if(new URL(page.url()).hostname!=='channels.weixin.qq.com')return false;
  const scopes=[page,...page.frames().filter(f=>f!==page.mainFrame()&&/^https:\/\/channels\.weixin\.qq\.com\//.test(f.url()))];
  for(const scope of scopes)if(await scope.getByText(channelsDraft(content)?/^(?:草稿保存成功|保存草稿成功|已保存草稿|保存成功)[！!。]?$/:/^(?:发表成功|发布成功)[！!。]?$/,{exact:true}).filter({visible:true}).count()===1)return true;
  return false;
}
export async function channelsReceipt(page,rule,content){
  const end=Date.now()+(rule.resultTimeoutMs||45000);
  do{if(await channelsSuccessVisible(page,content))return {simulated:false,id:null,url:null,action:channelsDraft(content)?'draft_saved':'published',submittedAt:new Date().toISOString(),evidence:channelsDraft(content)?'本次保存后官方页面显示草稿保存成功；未发表':'本次发表后官方页面显示成功；审核和公开状态未确认'};await pause(200);}while(Date.now()<end);
  throw fail('发表后未取得明确成功回执，请人工核对，禁止自动重发。');
}
function collectFinderUsernames(value,out=new Set(),depth=0){
  if(depth>6||out.size>20)return out;
  if(Array.isArray(value)){for(const item of value)collectFinderUsernames(item,out,depth+1);return out;}
  if(value&&typeof value==='object'){
    for(const [key,item] of Object.entries(value)){
      if(key==='finderUsername'&&typeof item==='string'&&/^[A-Za-z0-9_-]{2,64}$/.test(item))out.add(item);
      else if(item&&typeof item==='object')collectFinderUsernames(item,out,depth+1);
    }
  }
  return out;
}
export function watchChannelsIdentity(page){
  let latest=null;
  page.on('response',async response=>{
    try{const url=new URL(response.url());
      if(url.protocol!=='https:'||url.hostname!=='channels.weixin.qq.com'||response.status()!==200)return;
      // Console requests may carry a /micro/content prefix (Wujie iframes) and
      // cache-busting query strings, so match the API namespace instead of one URL.
      if(!/(?:^|\/)cgi-bin\/mmfinderassistant-bin\//.test(url.pathname))return;
      const accountLike=/(?:auth|account|user|self|finder)\b/i.test(url.pathname);
      // The console's own content list is the only other place the signed-in
      // account appears. Accept it only when every entry belongs to one account.
      const listLike=/\/(?:post\/post_list|collection\/get_collection_list)\b/i.test(url.pathname);
      if(!accountLike&&!listLike)return;
      const json=await response.json();
      if(json?.errCode!=null&&json.errCode!==0&&json?.ret!==0)return;
      const at=Date.now();
      if(!accountLike){
        const ids=collectFinderUsernames(json?.data??json);
        if(ids.size===1)latest={platformId:[...ids][0],displayName:'',at,source:'content-list'};
        return;
      }
      const data=json?.data||{};
      const finder=data.finderUser||data.finder_user||data.userAttr?.finderUser||json?.finderUser;
      const username=typeof finder?.finderUsername==='string'?finder.finderUsername
        :typeof finder?.finder_username==='string'?finder.finder_username
        :typeof finder?.username==='string'?finder.username:'';
      if(!username.trim())return;
      latest={platformId:username.trim(),aliases:[username.trim(),...(typeof finder.uniqId==='string'?[finder.uniqId]:[])],displayName:typeof finder.nickname==='string'?finder.nickname:'',at,source:'account'};
    }catch{}
  });return since=>latest&&latest.at>=since?latest:null;
}
export async function channelsIdentity(read,since,timeoutMs){const end=Date.now()+timeoutMs;do{const identity=read?.(since);if(identity)return identity;await pause(100);}while(Date.now()<end);return null;}

export async function channelsHomeIdentity(page){
  if(new URL(page.url()).origin!=='https://channels.weixin.qq.com')return null;
  const field=page.locator('.finder-uniq-id-wrap .finder-uniq-id#finder-uid-copy').filter({visible:true});
  if(await field.count()!==1)return null;
  const text=(await field.innerText()).trim(),copy=await field.getAttribute('data-clipboard-text');
  if(!/^\w{6,80}$/.test(text)||copy!==text)return null;
  return {platformId:text,displayName:''};
}
// The console may not call an auth endpoint at all (observed on /platform), so the
// logged-in 视频号 ID is read from the page's own data: document HTML, visible text
// and localStorage of the console and its same-origin iframes. Only public IDs are
// extracted; nothing leaves the machine. Multiple distinct IDs are ambiguous.
const scanCache=new WeakMap();
export async function channelsPageScan(page){
  if(!page||page.isClosed?.())return {candidates:[],textSample:'',storageKeys:[]};
  let scopes=[];
  try{scopes=[page,...page.frames().filter(f=>f!==page.mainFrame()&&/^https:\/\/channels\.weixin\.qq\.com\//.test(f.url()))];}catch{scopes=[page];}
  const ids=new Set();let textSample='',storageKeys=[];
  for(const [index,scope] of scopes.entries()){
    try{
      const found=await scope.evaluate(()=>{
        const html=(()=>{try{return document.documentElement?document.documentElement.innerHTML:'';}catch{return '';}})();
        const text=(()=>{try{return document.body?document.body.innerText:'';}catch{return '';}})();
        let keys=[],values=[];
        try{keys=Object.keys(localStorage).slice(0,20);values=keys.map(key=>String(localStorage.getItem(key)||''));}catch{}
        const out=new Set();
        // Matches plain JSON as well as escaped copies inside inline scripts.
        const pattern=/finderUsername\\?["']?\s*[:=]\s*\\?["']([A-Za-z0-9_-]{2,64})/g;
        for(const source of [html,text,...values])for(const m of String(source).matchAll(pattern))out.add(m[1]);
        const label=text.match(/(?:视频号|finder)\s*(?:ID|号)?\s*[:：]\s*([A-Za-z0-9_-]{6,80})/i);
        if(label)out.add(label[1]);
        return {ids:[...out],text:text.slice(0,200),keys};
      });
      for(const id of found.ids)ids.add(id);
      if(index===0){textSample=found.text||'';storageKeys=found.keys||[];}
    }catch{}
  }
  return {candidates:[...ids],textSample,storageKeys};
}
export async function channelsDocumentCandidates(page){
  return (await channelsPageScan(page)).candidates;
}
export async function channelsDocumentIdentity(page){
  const now=Date.now(),cached=scanCache.get(page);
  if(cached&&now-cached.at<5000)return cached.identity;
  const {candidates}=await channelsPageScan(page);
  const identity=candidates.length===1?{platformId:candidates[0],displayName:''}:null;
  scanCache.set(page,{at:now,identity});
  return identity;
}
