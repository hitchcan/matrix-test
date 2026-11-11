export function bilibiliIdentity(json){
 const d=json?.data;if(json?.code!==0||d?.isLogin!==true)return null;
 const mid=d.mid;if(typeof mid==='number'&&(!Number.isSafeInteger(mid)||mid<=0))return null;
 if(!['number','string'].includes(typeof mid)||!/^\d+$/.test(String(mid))||/^0+$/.test(String(mid)))return null;
 return {platformId:String(mid),displayName:typeof d.uname==='string'?d.uname:''};
}
export function watchBilibiliIdentity(page){
 let latest=null;page.on('response',async response=>{try{const u=new URL(response.url());if(u.protocol!=='https:'||u.hostname!=='api.bilibili.com'||u.pathname!=='/x/web-interface/nav'||response.status()!==200)return;const id=bilibiliIdentity(await response.json());latest=id?{...id,at:Date.now()}:null;}catch{}});return since=>latest&&latest.at>=since?latest:null;
}
export async function readBilibiliIdentity(page){
 if(new URL(page.url()).hostname!=='member.bilibili.com')return null;
 let timer;
 try{
  const json=await Promise.race([page.evaluate(async()=>{
   try{const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(4000)});if(!r.ok)return null;const j=await r.json();return j?.code===0&&j.data?.isLogin===true?{code:0,data:{isLogin:true,mid:j.data.mid,uname:j.data.uname}}:null;}catch{return null;}
  }),new Promise(r=>timer=setTimeout(()=>r(null),5000))]);
  return bilibiliIdentity(json);
 }catch{return null;}finally{clearTimeout(timer);}
}
