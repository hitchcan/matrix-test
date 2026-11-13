import {randomUUID} from 'node:crypto';

const fault=(message,code='image_upload_failed')=>Object.assign(Error(message),{state:'needs_manual',status:409,code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function pasteArticleImages(field,html,{isEditor,imageHosts,label,maxImages=20,timeoutMs=60000,onProgress=()=>{},pace=async()=>{}}) {
  const page=field.page(),prefix='MATRIXIMAGE'+randomUUID().replaceAll('-','');
  if(!isEditor(page.url()))throw fault(`${label}编辑页面已切换，已停止图片导入。`);
  const plan=await page.evaluate(({html,prefix,maxImages})=>{
    const doc=new DOMParser().parseFromString(html,'text/html'),images=[...doc.querySelectorAll('img')];
    if(images.length>maxImages)throw Error('image_limit');
    const entries=images.map((image,index)=>{
      const source=image.getAttribute('src'),marker=prefix+index+'END';
      if(!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(source))throw Error('unsupported_image_source');
      image.replaceWith(doc.createTextNode(marker));return {source,marker};
    });
    return {html:doc.body.innerHTML,entries};
  },{html,prefix,maxImages}).catch(()=>{throw fault(`${label}文章图片无法读取：请检查素材格式、引用或图片数量（最多 ${maxImages} 张）。`);});
  // Draft.js does not reliably upload data-URL images from text/html. Paste
  // trusted text/formatting first, then use native image clipboard file events.
  await field.evaluate(root=>{root.focus();const range=document.createRange();range.selectNodeContents(root);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  await field.press('Backspace');
  await page.evaluate(async html=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'})})]),plan.html);
  await field.press('ControlOrMeta+V');
  for(const [index,entry] of plan.entries.entries()) {
    onProgress(`上传${label}正文图片 ${index+1}/${plan.entries.length}`);
    await pace();
    const png=await page.evaluate(async source=>{
      const image=new Image();image.src=source;await image.decode();
      if(!image.width||!image.height||image.width*image.height>40000000)throw Error('invalid_image_dimensions');
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/png');
    },entry.source).catch(()=>{throw fault(`${label}正文图片解码失败或尺寸过大，未执行发布。`);});
    const end=Date.now()+5000;let selected=false;
    do {
      selected=await field.evaluate((root,marker)=>{
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),matches=[];
        while(walker.nextNode()){const text=walker.currentNode.textContent,at=text.indexOf(marker);if(at>=0)matches.push({node:walker.currentNode,at});}
        if(matches.length!==1)return false;
        root.focus();const {node,at}=matches[0],range=document.createRange();range.setStart(node,at);range.setEnd(node,at+marker.length);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true;
      },entry.marker);
      if(!selected)await pause(100);
    }while(!selected&&Date.now()<end);
    if(!selected)throw fault(`${label}正文图片插入位置无法确认，已暂停，未执行发布。`);
    if(!isEditor(page.url()))throw fault(`${label}编辑页面已切换，已停止图片导入。`);
    await field.press('Backspace');
    await page.evaluate(async png=>{
      const bytes=Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);
    },png);
    await field.press('ControlOrMeta+V');
    const deadline=Date.now()+timeoutMs;let ready=false;
    do {
      const status=await field.evaluate((root,{prefix,count,imageHosts})=>({
        ready:[...root.querySelectorAll('img')].filter(img=>{
          try{const url=new URL(img.currentSrc||img.src);return url.protocol==='https:'&&
            imageHosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host))&&img.complete&&img.naturalWidth>0;}catch{return false;}
        }).length>=count,
        marker:root.textContent.includes(prefix+String(count-1)+'END'),
        challenge:[...document.querySelectorAll('input[autocomplete="one-time-code"],iframe[src*="captcha"]')].some(n=>n.getClientRects().length)
      }),{prefix,count:index+1,imageHosts});
      if(status.challenge)throw Object.assign(fault(`${label}图片上传需要本人完成安全验证。`),{state:'needs_verification'});
      ready=status.ready&&!status.marker;if(ready)break;
      await pause(200);
    }while(Date.now()<deadline);
    if(!ready)throw fault(`${label}正文图片 ${index+1}/${plan.entries.length} 上传未完成：未取得可解码的平台图片地址。已暂停，未执行发布。`);
  }
}
