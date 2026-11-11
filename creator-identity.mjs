import {watchBilibiliIdentity} from './bilibili-identity.mjs';
const specs={
  douyin:{host:'creator.douyin.com',pattern:/抖音号\s*[:：]?\s*([A-Za-z0-9_.-]+)/,selector:'[data-account-self],.user-info,[class*="userInfo"],[class*="accountInfo"],[class*="user-info"],[class*="account-info"]'},
  xhs:{host:'creator.xiaohongshu.com',pattern:/小红书号\s*[:：]?\s*([A-Za-z0-9_.-]+)/,selector:'[data-account-self],.user-info,[class*="userInfo"],[class*="account-info"],[class*="user-info"]'},
};

export async function creatorTextIdentity(page,platform){
  const spec=specs[platform];if(!spec||new URL(page.url()).hostname!==spec.host)return null;
  const values=await page.locator(spec.selector).evaluateAll(ns=>ns.filter(n=>n.getClientRects().length).map(n=>n.innerText||''));
  const ids=new Set();for(const text of values){const m=text.match(spec.pattern);if(m)ids.add(m[1]);}
  if(ids.size!==1)return null;
  return {platformId:[...ids][0],displayName:''};
}

export async function creatorIdentityReady(page,platform,readIdentity,since,{timeoutMs=10000}={}){
  const spec=specs[platform],end=Date.now()+timeoutMs;if(!spec)return null;
  do{
    if(new URL(page.url()).hostname!==spec.host){await new Promise(r=>setTimeout(r,100));continue;}
    const fresh=readIdentity?.(since);if(fresh)return fresh;
    let timer;
    try{
      const snapshot=await Promise.race([
        page.evaluate(({selector,pattern})=>{
          const visible=n=>{for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false;}return Boolean(n.getClientRects().length);};
          const login=[...document.querySelectorAll('button,span,div')].some(n=>visible(n)&&/^(扫码登录|手机号登录|请先登录)$/.test(n.textContent.trim())&&![...n.children].some(c=>c.textContent.trim()===n.textContent.trim()));
          const ids=[...new Set([...document.querySelectorAll(selector)].filter(visible).flatMap(n=>{const m=(n.innerText||'').match(new RegExp(pattern));return m?[m[1]]:[];}))];return {login,ids};
        },{selector:spec.selector,pattern:spec.pattern.source}),
        new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('identity DOM not ready')),Math.max(1,Math.min(1000,end-Date.now())))),
      ]);
      const current=readIdentity?.(since);if(current)return current;
      if(snapshot.login)throw Object.assign(new Error('请在可见后台完成扫码登录。'),{state:'needs_login',status:409});
      if(snapshot.ids.length===1)return {platformId:snapshot.ids[0],displayName:''};
    }catch(e){if(e.state)throw e;}finally{clearTimeout(timer);}
    await new Promise(r=>setTimeout(r,100));
  }while(Date.now()<end);
  return readIdentity?.(since)||null;
}

// Observe only same-origin self-account responses requested by the official page itself.
// Never replay signed requests or use Cookie existence as proof of an authenticated account.
export function watchCreatorIdentity(page,platform){
  if(platform==='bilibili')return watchBilibiliIdentity(page);
  const spec=specs[platform];let latest=null;
  if(!spec)return ()=>null;
  page.on('response',async response=>{
    try{
      const url=new URL(response.url());
      if(url.hostname!==spec.host || !/\/(?:user\/selfinfo|user\/me|user\/info|account\/info)\/?$/.test(url.pathname) || response.status()!==200)return;
      if(['user_id','uid','sec_user_id','target_user_id'].some(k=>url.searchParams.has(k)))return;
      const json=await response.json();
      if(json.success===false)return;
      if(!(json.success===true || json.code===0 || json.status_code===0))return;
      const d=json.data?.user_info||json.data?.user||json.data||json.user;
      if(!d||typeof d!=='object')return;
      const aliases=[...new Set((platform==='douyin'?[d.unique_id,d.sec_uid,d.user_id,d.uid]:[d.red_id,d.redId,d.user_id,d.userId]).filter(v=>(typeof v==='string'||typeof v==='number')&&String(v)&&String(v)!=='0').map(String))];
      if(aliases.length)latest={platformId:aliases[0],aliases,displayName:typeof d.nickname==='string'?d.nickname:'',at:Date.now()};
    }catch{}
  });
  return since=>latest&&latest.at>=since?latest:null;
}
