const fail=message=>Object.assign(Error(message),{status:422});
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function reportContent(output,assets,{requireImages=false,sources=[]}={}){
  if(typeof output?.title!=='string'||!output.title.trim()||output.title.length>500)throw fail('图文标题无效');
  const byId=new Map(assets.filter(a=>a.mime?.startsWith('image/')).map(a=>[a.id,a]));
  let blocks=output.blocks;
  if(blocks==null){
    if(typeof output.body!=='string'||!output.body.trim()||output.body.length>100000||!Array.isArray(output.assetIds))throw fail('图文正文无效');
    const paragraphs=output.body.split(/\n+/).filter(Boolean).map(text=>({type:'paragraph',text}));
    // Legacy output is also distributed through the story rather than appended as a gallery.
    const ids=[...new Set(output.assetIds)],merged=[];
    if(ids.some(id=>!byId.has(id)))throw fail('图片超出授权范围');
    const count=Math.max(paragraphs.length,ids.length);
    for(let i=0;i<count;i++){if(paragraphs[i])merged.push(paragraphs[i]);if(ids[i])merged.push({type:'image',assetId:ids[i],caption:''});}
    blocks=merged;
  }
  if(!Array.isArray(blocks)||!blocks.length||blocks.length>150)throw fail('图文段落无效');
  const normalized=[],html=[],text=[],ids=[];
  for(const block of blocks){
    if(!block||!['paragraph','heading','image'].includes(block.type))throw fail('图文段落类型无效');
    if(block.type!=='image'){
      if(typeof block.text!=='string'||!block.text.trim()||block.text.length>20000)throw fail('文字段落无效');
      const value=block.text.trim();normalized.push({type:block.type,text:value});text.push(value);const tag=block.type==='heading'?'h2':'p';html.push(`<${tag}>${esc(value)}</${tag}>`);continue;
    }
    const asset=byId.get(block.assetId);if(!asset||ids.includes(asset.id)||ids.length>=12)throw fail('配图不存在、重复或超过12张');
    if(block.caption!=null&&(typeof block.caption!=='string'||block.caption.length>1000))throw fail('图片说明无效');
    const caption=block.caption?.trim()||'';normalized.push({type:'image',assetId:asset.id,caption});ids.push(asset.id);
    html.push(`<p><img src="/media/${encodeURIComponent(asset.id)}" alt="${esc(caption)}"></p>`);
    const source=asset.source;
    const credit=source?`资料配图（非本次事件现场）${caption?'：'+caption:''}｜图片：${source.author}｜${source.license}${source.licenseUrl?' '+source.licenseUrl:''}｜来源：${source.pageUrl}`:caption;
    if(credit){html.push('<p>'+esc(credit)+'</p>');text.push(credit);}
  }
  for(const source of sources.slice(0,6)){const reference='参考资料 '+source.id+'：'+source.title+'｜'+source.url+(source.date?'｜发布日期：'+source.date:'');html.push('<p>'+esc(reference)+'</p>');text.push(reference);}
  if(!normalized.some(b=>b.type==='paragraph')||text.join('\n').length>100000||(requireImages&&!ids.length))throw fail('报道需包含正文及所需配图');
  return {title:output.title.trim(),body:text.join('\n'),bodyHtml:html.join(''),assetIds:ids,blocks:normalized};
}
