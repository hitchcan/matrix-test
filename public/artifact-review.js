import {safeHtml} from '/editor.bundle.js';
export const reportPreview=artifact=>'<div class="report-preview">'+safeHtml(artifact.bodyHtml||'')+'</div>';
export function openArtifactEditor({run,target,esc,api,openDialog,refresh,toast}){
  let current=target,blocks=structuredClone(target.artifact.blocks||[{type:'paragraph',text:target.artifact.body}]);
  const available=[...target.authorized_assets,...(target.artifact.generatedCoverId?[{id:target.artifact.generatedCoverId,name:'生成的首图',mime:'image/png'}]:[])].filter(a=>a.mime?.startsWith('image/'));
  let title=target.artifact.title;
  const read=()=>{const form=document.querySelector('#artifact-editor');if(!form)return;title=form.elements.title.value;blocks.forEach((b,i)=>{const input=form.querySelector('[data-block-input="'+i+'"]');if(input)b[b.type==='image'?'caption':'text']=input.value;});};
  function show(message=''){
    openDialog(`<h2>编辑待审图文</h2><p>版本 ${current.revision} · 保存修改后仍保持待审，确认后才进入发布流程。</p><form id="artifact-editor"><label class="field">发布标题<input name="title" maxlength="500" required value="${esc(title)}"></label><div class="report-blocks">${blocks.map((b,i)=>`<section class="report-block"><div class="task-actions"><strong>${b.type==='image'?'配图':b.type==='heading'?'小标题':'正文'}</strong><button type="button" class="button secondary small" data-move-block="${i}" data-offset="-1">上移</button><button type="button" class="button secondary small" data-move-block="${i}" data-offset="1">下移</button><button type="button" class="button secondary small" data-remove-block="${i}">移除</button></div>${b.type==='image'?`<img src="/media/${encodeURIComponent(b.assetId)}" alt="配图预览" loading="lazy"><label class="field">图片说明<input data-block-input="${i}" maxlength="1000" value="${esc(b.caption||'')}"></label>`:`<textarea data-block-input="${i}" maxlength="20000" aria-label="第${i+1}段">${esc(b.text)}</textarea>`}</section>`).join('')}</div><div class="task-actions"><button type="button" class="button secondary small" id="report-add-paragraph">添加段落</button><select id="report-image-choice" aria-label="可用图片">${available.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button type="button" class="button secondary small" id="report-add-image" ${available.length?'':'disabled'}>插入图片</button></div><p id="report-edit-status" role="status">${esc(message)}</p><div class="task-actions"><button type="submit" class="button secondary">保存修改</button><button type="button" class="button" id="report-approve">确认此版本并发布</button></div><label class="field">交给主 agent 的修改意见<textarea name="feedback" maxlength="2000" placeholder="例如：缩短导语，删除夸张表述，把第二张图移到背景介绍之后"></textarea></label><button type="button" class="button secondary" id="report-revise">保存并让 agent 再审改</button></form><details><summary>查看已保存的图文排版</summary>${reportPreview(current.artifact)}</details><details><summary>外接模型初稿</summary><p class="detail-body">${esc(current.draft?.title||'本次由主agent直接生成')}</p><p class="detail-body">${esc(current.draft?.body||'')}</p></details><details><summary>当前审改说明与历史版本</summary><p class="detail-body">${esc(current.artifact.reviewNotes||'暂无审改说明')}</p>${(current.versions||[]).map(v=>`<p>版本 ${v.revision} · ${esc(v.note)} · ${esc(v.artifact.title)}</p>`).join('')}</details>`);
    const form=document.querySelector('#artifact-editor'),status=document.querySelector('#report-edit-status');
    form.querySelectorAll('[data-move-block]').forEach(button=>button.onclick=()=>{read();const from=Number(button.dataset.moveBlock),to=from+Number(button.dataset.offset);if(to>=0&&to<blocks.length)[blocks[from],blocks[to]]=[blocks[to],blocks[from]];show();});
    form.querySelectorAll('[data-remove-block]').forEach(button=>button.onclick=()=>{read();blocks.splice(Number(button.dataset.removeBlock),1);show();});
    form.querySelector('#report-add-paragraph').onclick=()=>{read();blocks.push({type:'paragraph',text:''});show();};
    form.querySelector('#report-add-image').onclick=()=>{read();const id=form.querySelector('#report-image-choice').value;if(blocks.some(b=>b.assetId===id)){toast('这张图片已在正文中');return;}blocks.push({type:'image',assetId:id,caption:''});show();};
    const save=async()=>{read();const result=await api(`runs/${run.id}/targets/${current.id}/edit`,{expectedRevision:current.revision,title,blocks});current=result.targets.find(t=>t.id===current.id);blocks=structuredClone(current.artifact.blocks);return current;};
    const act=async fn=>{const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){status.textContent=e.message;toast(e.message);}finally{buttons.forEach(b=>b.disabled=false);}};
    form.onsubmit=e=>{e.preventDefault();void act(async()=>{if(!form.reportValidity())return;await save();show('修改已保存');await refresh();});};
    form.querySelector('#report-approve').onclick=()=>void act(async()=>{if(!form.reportValidity())return;await save();await api(`runs/${run.id}/targets/${current.id}/approve`,{expectedRevision:current.revision});document.querySelector('#detail').close();await refresh(true);toast('已确认稿件，按计划进入发布流程');});
    form.querySelector('#report-revise').onclick=()=>void act(async()=>{
      const feedback=form.elements.feedback.value.trim();if(!feedback){status.textContent='请填写修改意见';return;}
      await save();await api(`runs/${run.id}/targets/${current.id}/revise`,{expectedRevision:current.revision,feedback});status.textContent='主agent正在按意见审改，可关闭窗口后在运行详情查看。';
      for(let i=0;i<120;i++){
        await new Promise(r=>setTimeout(r,1500));if(!form.isConnected||!document.querySelector('#detail').open)return;
        const detail=await api('runs/'+run.id),item=detail.targets.find(t=>t.id===current.id);
        if(item.state==='awaiting_review'){current=item;blocks=structuredClone(item.artifact.blocks);title=item.artifact.title;show(item.reason?'本次审改未完成，保留了上一版，可修改后重新审改。':'agent 审改完成，请检查此版本');await refresh();return;}
        if(!['revision_pending','revising'].includes(item.state)){status.textContent='任务状态已改变，请关闭后重新查看运行详情。';return;}
      }
    });
  }
  show();
}
