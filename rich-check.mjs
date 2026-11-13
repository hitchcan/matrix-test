// Compare meaning rather than markup: Draft.js renders bold/italic as styled spans.
export async function richComparison(field,html) {
  return field.evaluate((root,html)=>{
    const expected=new DOMParser().parseFromString(html,'text/html').body;
    const compact=s=>s.replace(/[\s\u200b\ufeff]/g,'');
    let ignoredUiChars=0;
    function emptyImageCaption(textNode) {
      if(location.hostname==='member.bilibili.com'&&location.pathname==='/york/read-editor') {
        const caption=textNode.parentElement.closest('.eva3-image-caption.is-placeholder[data-empty="true"]'),container=caption?.closest('.eva3-enhanced-image-wrapper');
        return !!container&&root.contains(container)&&!!container.querySelector('img')&&compact(caption.textContent)==='点此添加图片注释，最多100字（可选）';
      }
      if(location.hostname!=='zhuanlan.zhihu.com')return false;
      const caption=textNode.parentElement.closest('.Image-caption.is-placeholder');
      const container=caption?.closest('.Image-captionContainer');
      return !!caption&&!!container&&root.contains(container)&&!!container.querySelector('img')&&
        compact(caption.textContent)==='添加图片注释，不超过140字（可选）';
    }
    function read(node,computed){
      const chars=[],marks=[];
      const walker=node.ownerDocument.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const text=compact(walker.currentNode.textContent);if(!text)continue;
        // Zhihu renders this 18-character hint as a real text node inside the
        // editor. Ignore only its empty-caption widget, never matching prose or
        // a real user caption. Image loading is checked independently below.
        if(computed&&emptyImageCaption(walker.currentNode)){ignoredUiChars+=text.length;continue;}
        const effective=computed?getComputedStyle(walker.currentNode.parentElement):null;
        let bold=computed?/^(bold|[6-9]00)$/.test(effective.fontWeight):null,italic=computed?effective.fontStyle==='italic':null,underline=false,strike=false;
        for(let e=walker.currentNode.parentElement;e && e!==node.parentElement;e=e.parentElement){
          const style=computed?getComputedStyle(e):e.style;
          if(bold===null){if(style.fontWeight)bold=/^(bold|[6-9]00)$/.test(style.fontWeight);else if(/^(STRONG|B|H[1-6])$/.test(e.tagName))bold=true;}
          if(italic===null){if(style.fontStyle)italic=style.fontStyle==='italic';else if(/^(EM|I)$/.test(e.tagName))italic=true;}
          underline ||= e.tagName==='U'||/underline/.test(style.textDecorationLine||style.textDecoration);
          strike ||= /^(S|STRIKE|DEL)$/.test(e.tagName)||/line-through/.test(style.textDecorationLine||style.textDecoration);
          if(e===node)break;
        }
        for(const c of text){chars.push(c);marks.push({bold,italic,underline,strike});}
      }
      return {text:chars.join(''),marks};
    }
    const a=read(expected,false),b=read(root,true),missing=[];
    if(a.text===b.text){for(const mark of ['bold','italic','underline','strike'])if(a.marks.some((v,i)=>v[mark]&&!b.marks[i]?.[mark]))missing.push(mark);}
    for(const tag of ['h1,h2,h3,h4,h5,h6','ul','ol','table','img']){
      const wanted=expected.querySelectorAll(tag).length;
      const actual=tag==='img'?[...root.querySelectorAll(tag)].filter(n=>!n.matches('.ProseMirror-separator,[mark-placeholder]')).length:root.querySelectorAll(tag).length;
      if(wanted && actual<wanted)missing.push(tag);
    }
    if(location.hostname==='zhuanlan.zhihu.com'&&expected.querySelector('img')) {
      const images=[...root.querySelectorAll('img')];
      if(images.some(img=>{
        try{const url=new URL(img.currentSrc||img.src);return url.protocol!=='https:'||
          !(url.hostname.endsWith('.zhimg.com')||url.hostname.endsWith('.zhihu.com'))||!img.complete||!img.naturalWidth;}catch{return true;}
      }))missing.push('image_upload');
    }
    if(location.hostname==='member.bilibili.com'&&location.pathname==='/york/read-editor'&&expected.querySelector('img')) {
      const images=[...root.querySelectorAll('img')].filter(n=>!n.matches('.ProseMirror-separator,[mark-placeholder]'));
      if(images.some(img=>{try{const u=new URL(img.currentSrc||img.src);return u.protocol!=='https:'||!['hdslb.com','biliimg.com'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host))||!img.complete||!img.naturalWidth;}catch{return true;}})||root.querySelector('.eva3-loading,.eva3-error'))missing.push('image_upload');
    }
    return {valid:a.text===b.text&&!missing.length,textMatch:a.text===b.text,expectedChars:a.text.length,actualChars:b.text.length,missing,ignoredUiChars};
  },html);
}
export async function waitForRich(field,html,timeout=4000){
  const end=Date.now()+timeout;let result;
  do{result=await richComparison(field,html);if(result.valid)return result;await new Promise(r=>setTimeout(r,150));}while(Date.now()<end);
  return result;
}
