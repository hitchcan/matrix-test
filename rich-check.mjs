// Compare meaning rather than markup: Draft.js renders bold/italic as styled spans.
export async function richComparison(field,html) {
  return field.evaluate((root,html)=>{
    const expected=new DOMParser().parseFromString(html,'text/html').body;
    const compact=s=>s.replace(/[\s\u200b\ufeff]/g,'');
    function read(node,computed){
      const chars=[],marks=[];
      const walker=node.ownerDocument.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const text=compact(walker.currentNode.textContent);if(!text)continue;
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
      if(wanted && root.querySelectorAll(tag).length<wanted)missing.push(tag);
    }
    return {valid:a.text===b.text&&!missing.length,textMatch:a.text===b.text,expectedChars:a.text.length,actualChars:b.text.length,missing};
  },html);
}
export async function waitForRich(field,html,timeout=4000){
  const end=Date.now()+timeout;let result;
  do{result=await richComparison(field,html);if(result.valid)return result;await new Promise(r=>setTimeout(r,150));}while(Date.now()<end);
  return result;
}
