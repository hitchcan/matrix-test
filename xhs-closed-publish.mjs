const fail=message=>Object.assign(new Error('小红书：'+message),{state:'needs_manual',status:409});
const attrs=n=>Object.fromEntries((n.attributes||[]).reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v,a[i+1]]],[]));
const children=n=>[...(n.children||[]),...(n.shadowRoots||[])];
const flatten=n=>[n,...children(n).flatMap(flatten)];
const text=n=>(n.nodeValue||'')+children(n).map(text).join('');

async function inspect(page,action){
 const c=await page.context().newCDPSession(page);
 try{
  const {root}=await c.send('DOM.getDocument',{depth:-1,pierce:true});
  const hosts=flatten(root).filter(n=>n.nodeName==='XHS-PUBLISH-BTN'&&attrs(n)['is-publish']==='true');
  if(hosts.length!==1)throw fail('封装发布组件不唯一，未执行最终点击。');
  const host=hosts[0],buttons=flatten(host).filter(n=>n.nodeName==='BUTTON'&&text(n).trim()==='发布'&&/\bbg-red\b/.test(attrs(n).class||''));
  if(buttons.length!==1)throw fail('封装组件中的红色发布按钮不唯一。');
  const button=buttons[0],a=attrs(button),h=attrs(host);
  const enabled=!Object.hasOwn(a,'disabled')&&a['aria-disabled']!=='true'&&a['aria-busy']!=='true'&&h['submit-disabled']!=='true'&&h['submit-loading']!=='true';
  return await action({c,host,button,enabled});
 }finally{await c.detach().catch(()=>{});}
}

export async function xhsClosedPublishButton(page){
 const host=page.locator('xhs-publish-btn[is-publish="true"]').filter({visible:true});
 if(await host.count()===0)return null;
 if(await host.count()!==1)throw fail('页面中存在多个发布组件。');
 await inspect(page,async()=>{});
 return {
  count:async()=>inspect(page,async()=>1),
  isEnabled:async()=>inspect(page,async({enabled})=>enabled),
  click:async()=>inspect(page,async({c,host,button,enabled})=>{
   if(!enabled)throw fail('红色发布按钮尚未可用。');
   await c.send('DOM.scrollIntoViewIfNeeded',{backendNodeId:button.backendNodeId});
   const {model}=await c.send('DOM.getBoxModel',{backendNodeId:button.backendNodeId});
   const q=model.content,x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;
   const hit=await c.send('DOM.getNodeForLocation',{x:Math.round(x),y:Math.round(y),includeUserAgentShadowDOM:true});
   const allowed=new Set([host.backendNodeId,...flatten(button).map(n=>n.backendNodeId)]);
   if(!allowed.has(hit.backendNodeId))throw fail('红色发布按钮被其他内容遮挡，未点击。');
   await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
   await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
   await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  }),
 };
}
