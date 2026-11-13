import {pasteArticleImages} from './article-images.mjs';
import {isZhihuEditor} from './zhihu-article.mjs';
export function pasteZhihuImages(field,html,options={}) {
  return pasteArticleImages(field,html,{...options,isEditor:isZhihuEditor,imageHosts:['zhimg.com','zhihu.com'],label:'知乎'});
}
