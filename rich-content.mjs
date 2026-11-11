import sanitizeHtml from 'sanitize-html';

export function cleanHtml(html) {
  return sanitizeHtml(typeof html === 'string' ? html : '', {
    allowedTags: ['p','br','h1','h2','h3','h4','strong','b','em','i','u','s','strike','ul','ol','li','blockquote','pre','code','hr','a','img','table','thead','tbody','tr','td','th','span','div'],
    allowedAttributes: {'*':['style'],a:['href','title'],img:['src','alt','width','height'],td:['colspan','rowspan'],th:['colspan','rowspan']},
    allowedSchemes:['https','http','mailto'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,
    allowedStyles:{'*':{'text-align':[/^(left|center|right|justify)$/],color:[/^#[\da-f]{3,8}$/i,/^rgb\([\d,\s]+\)$/],'font-size':[/^\d{1,2}(px|pt)$/],'font-family':[/^[\w\s,"'\-\u4e00-\u9fff]+$/],'font-weight':[/^(bold|[1-9]00)$/],'font-style':[/^italic$/],'text-decoration':[/^(underline|line-through)$/]}},
    exclusiveFilter: f => f.tag==='img' && !(/^\/media\/[\w-]+$/.test(f.attribs.src||'') || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(f.attribs.src||'')),
  });
}
export function cleanContent(content) {
  if (!content || typeof content!=='object') return content;
  const result={...content};
  if (result.bodyHtml) result.bodyHtml=cleanHtml(result.bodyHtml);
  if (result.versions && typeof result.versions==='object') result.versions=Object.fromEntries(Object.entries(result.versions).map(([p,v])=>[p,{...v,...(v?.bodyHtml?{bodyHtml:cleanHtml(v.bodyHtml)}:{})}]));
  return result;
}
