// Endpoint and response envelope verified by static inspection of the supplied
// official bundle's bootstrap / mutateUser path. Observe page traffic only.
const numericId=/^\d{3,}$/, kwaiId=/^[A-Za-z0-9_.-]{3,}$/;
function pick(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return null;
  if(data.logined===false||data.loggedIn===false)return null;
  const id=String(data.userId??data.user_id??data.uid??'');
  const kwai=String(data.userKwaiId??data.user_kwai_id??data.kwaiId??'');
  const numeric=numericId.test(id)&&id!=='0',named=kwaiId.test(kwai);
  if(!numeric&&!named)return null;
  return {platformId:numeric?id:kwai,aliases:[...new Set([id,kwai].filter(v=>Boolean(v)&&v!=='0'))],
    displayName:String(data.userName??data.user_name??data.nickname??'')};
}
// The platform appends cache/signature query strings to its own endpoints, so the
// path check is intentionally a pattern instead of an exact match.
export function watchKuaishouIdentity(page){
  let latest=null;
  page.on('response',async response=>{
    try{
      const url=new URL(response.url());
      if(url.protocol!=='https:'||url.hostname!=='cp.kuaishou.com'||response.status()!==200)return;
      if(['userId','user_id','uid','target_user_id'].some(k=>url.searchParams.has(k)))return;
      if(!/(?:authority|account|user)\/(?:current|self|info|me)\b/i.test(url.pathname))return;
      const json=await response.json();
      if(json?.result!==1&&json?.code!==0&&json?.result!==0)return;
      const data=json?.data;
      const identity=pick(data);
      if(identity)latest={...identity,at:Date.now()};
    }catch{}
  });
  return since=>latest&&latest.at>=since?latest:null;
}
