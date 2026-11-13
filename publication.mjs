export function publicationOf(content) {
  const mode=content?.publication?.mode || 'manual';
  return {mode,silent:mode==='auto' && content?.publication?.silent!==false,aiAssisted:typeof content?.publication?.aiAssisted==='boolean'?content.publication.aiAssisted:null};
}
export function publicationIssues(content) {
  if(content?.publication===undefined)return [];
  const p=content.publication;
  if(!p || !['manual','auto'].includes(p.mode) || typeof p.aiAssisted!=='boolean')return ['请选择发布方式，以及是否勾选 AI 辅助创作声明'];
  if(p.silent!==undefined && typeof p.silent!=='boolean')return ['静默执行选项格式无效'];
  if(p.douyinVisibility!=null && !['public','private'].includes(p.douyinVisibility))return ['抖音可见范围无效'];
  return [];
}
