import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import {Table,TableRow,TableCell,TableHeader} from '@tiptap/extension-table';
import DOMPurify from 'dompurify';
DOMPurify.addHook('uponSanitizeAttribute',(node,data)=>{
  if(node.nodeName==='IMG' && data.attrName==='src' && !(/^\/media\/[\w-]+$/.test(data.attrValue)||/^data:image\/(png|jpeg|gif|webp);base64,/i.test(data.attrValue)))data.keepAttr=false;
});

export const safeHtml = html => DOMPurify.sanitize(html || '',{USE_PROFILES:{html:true},FORBID_TAGS:['iframe','form','input','button','video','audio'],FORBID_ATTR:['srcset']});
const textHtml = text => '<p>'+String(text||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'</p><p>')+'</p>';
export function mountEditor(container, value, onChange, {onImport,onImage}={}) {
  const toolbar=document.createElement('div');toolbar.className='rich-toolbar';
  const area=document.createElement('div');area.className='rich-area';
  container.replaceChildren(toolbar,area);
  const editor=new Editor({element:area,injectCSS:false,extensions:[StarterKit.configure({link:{openOnClick:false}}),TextStyle,Color,FontFamily,FontSize,TextAlign.configure({types:['heading','paragraph']}),Image.configure({allowBase64:true}),Table.configure({resizable:false}),TableRow,TableCell,TableHeader],content:safeHtml(value.html||textHtml(value.text)),editorProps:{attributes:{'aria-label':value.label||'文章正文',role:'textbox','aria-multiline':'true'},transformPastedHTML:safeHtml},onUpdate:({editor})=>onChange({html:editor.getHTML(),text:editor.getText({blockSeparator:'\n'})})});
  const commands=[['撤销',c=>c.undo()],['重做',c=>c.redo()],['正文',c=>c.setParagraph()],['标题2',c=>c.toggleHeading({level:2})],['标题3',c=>c.toggleHeading({level:3})],['加粗',c=>c.toggleBold()],['斜体',c=>c.toggleItalic()],['下划线',c=>c.toggleUnderline()],['删除线',c=>c.toggleStrike()],['无序列表',c=>c.toggleBulletList()],['编号列表',c=>c.toggleOrderedList()],['引用',c=>c.toggleBlockquote()],['左对齐',c=>c.setTextAlign('left')],['居中',c=>c.setTextAlign('center')],['右对齐',c=>c.setTextAlign('right')],['表格',c=>c.insertTable({rows:3,cols:3,withHeaderRow:true})],['清除格式',c=>c.unsetAllMarks().clearNodes()]];
  for(const [label,action] of commands){const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-label',label);b.onmousedown=e=>e.preventDefault();b.onclick=()=>action(editor.chain().focus()).run();toolbar.append(b);}
  const fonts=document.createElement('select');fonts.setAttribute('aria-label','字体');for(const [v,t] of [['','默认字体'],['Microsoft YaHei','微软雅黑'],['SimSun','宋体'],['Arial','Arial'],['Times New Roman','Times New Roman']])fonts.add(new Option(t,v));fonts.onchange=()=>editor.chain().focus().setFontFamily(fonts.value).run();toolbar.append(fonts);
  const sizes=document.createElement('select');sizes.setAttribute('aria-label','字号');for(const n of [12,14,16,18,24,32])sizes.add(new Option(n+'px',n+'px'));sizes.value='16px';sizes.onchange=()=>editor.chain().focus().setFontSize(sizes.value).run();toolbar.append(sizes);
  const color=document.createElement('input');color.type='color';color.setAttribute('aria-label','文字颜色');color.oninput=()=>editor.chain().focus().setColor(color.value).run();toolbar.append(color);
  const link=document.createElement('button');link.textContent='链接';link.type='button';link.onclick=()=>{const url=prompt('输入 https:// 链接（留空移除）',editor.getAttributes('link').href||'');if(url===null)return;if(!url)editor.chain().focus().unsetLink().run();else if(/^https?:\/\//i.test(url))editor.chain().focus().setLink({href:url}).run();};toolbar.append(link);
  for(const [label,cb] of [['插入图片',onImage],['导入 Word',onImport]])if(cb){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>cb(editor);toolbar.append(b);}
  return editor;
}
