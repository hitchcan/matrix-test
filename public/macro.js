import {bindImageConfig} from './image-config.js';
import {openArtifactEditor,reportPreview} from './artifact-review.js';
import {bindVideoConfig} from './video-config.js';
import {bindSchedule,readSchedule} from './task-schedule.js';
import {bindModelConfig} from './model-config.js';
import {taskScreen} from './task-view.js';
let editing=null;
const keys=new Map();
const reasons={video_download_host:'视频下载域名未获准',video_download_failed:'视频下载失败，可继续下载原任务结果',video_too_large:'生成视频超过150MB下载上限',invalid_video_output:'下载结果不是有效MP4',missing_search_key:'请先填写 DeepSeek 检索 API Key',search_auth_failed:'检索密钥无效或无权限',search_balance_required:'检索账户余额不足',search_rate_limited:'检索服务限流，请稍后处理',domestic_search_failed:'国内检索请求失败',domestic_search_empty:'未检索到可用资料',domestic_search_unconfigured:'中文资料检索需要选择 DeepSeek 服务',search_request_limit:'本目标检索请求次数已用尽',search_query_too_long:'检索词与指定网站合计过长，请减少检索范围',image_search_failed:'图片检索请求失败，未发布无配图稿件',image_search_empty:'未检索到可用配图，请调整主题或手选图片',invalid_image_queries:'agent返回的检索词无效',invalid_editorial_review:'agent审稿输出未通过校验',revision_unknown:'本次修改未完成，上一版保留',video_call_limit:'本次运行的视频生成次数已达上限',asset_range_limit:'日期区间内素材超过100份，请缩小区间并重新运行',missing_generation_model:'agent 或写作模型配置缺失',same_generation_model:'旧的同模型限制已解除，可恢复这个目标',vision_required:'请配置支持图片输入的模型并勾选图片输入能力',source_media_limit:'读取内容最多可选择 8 份素材',source_media_size:'读取内容的单份素材不能超过 150 MB',video_provider_changed:'视频服务配置已更换，请恢复原配置查询原任务',missing_video_model:'未配置视频生成模型',video_budget_unconfigured:'未配置视频生成费用预算',video_creation_unknown:'生成请求结果不明，请核对供应商任务',video_generation_failed:'视频生成失败或超时',video_provider_failed:'视频服务或下载失败',card_render_failed:'首图生成失败，可使用原稿重试',image_text_failed:'图片识别失败，请校正素材文字后恢复',asset_cooldown:'素材正在冷却',cost_limit:'预留费用已达预算',missed_schedule:'已错过本期发布时间',missing_model:'未配置生成模型',generation_unknown:'模型调用中断，费用或结果待确认',insufficient_assets:'授权图片不足',
  invalid_artifact:'模型返回的稿件未通过校验',budget_exhausted:'调用预算已用尽',dispatch_validation:'稿件或账号未通过分发校验',account_unavailable:'账号不可用'};
const states={awaiting_review:'待审稿，可编辑后确认发布',revision_pending:'等待agent再审改',revising:'agent正在按意见修改',card_pending:'等待媒体准备',rendering:'正在准备媒体',pending:'待处理',generating:'生成中',ready:'成品就绪，等待发布时间',dispatched:'已创建分发任务',blocked:'已阻断',cancelled:'已停止'};
export function macroScreen(data,esc) {return taskScreen(data,esc,editing);}
export function bindMacros({data,esc,api,refresh,render,toast,openDialog}) {
  const form=document.querySelector('#macro-form');if(!form)return;
  const sectionKey='matrix.task.sections.v1';let sectionState={};
  try{sectionState=JSON.parse(sessionStorage.getItem(sectionKey)||'{}')||{};}catch{}
  document.querySelectorAll('[data-task-section]').forEach(section=>{
    const key=section.dataset.taskSection;if(typeof sectionState[key]==='boolean')section.open=sectionState[key];
    let userToggle=false;
    section.querySelector(':scope > summary').addEventListener('click',event=>{if(!event.target.closest('button,a,input,select'))userToggle=true;});
    section.addEventListener('toggle',()=>{if(!userToggle)return;userToggle=false;sectionState[key]=section.open;try{sessionStorage.setItem(sectionKey,JSON.stringify(sectionState));}catch{}});
  });
  // Browser validation must be able to focus required controls inside folds.
  document.querySelectorAll('.task-fold').forEach(section=>section.addEventListener('invalid',event=>{
    for(let parent=event.target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  },true));
  bindSchedule(form);bindImageConfig({data,api,toast});
  bindVideoConfig({data,esc,api,toast,onChange:()=>{
    const select=form.elements.videoModelId,value=select.value;
    select.innerHTML='<option value="">使用默认视频配置（创建运行时确定）</option>'+(data.videoSettings?.profiles||[]).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+' · '+esc(p.model)+'</option>').join('');
    if([...select.options].some(o=>o.value===value))select.value=value;
    else if(value)select.add(new Option('原视频配置不可用，请重新选择',value,true,true));
    document.querySelector('.task-video-model .badge').textContent=data.videoSettings?.configured?'已配置':'待配置';
  }});
  const syncMode=()=>{
    const mode=form.elements.taskMode.value,direct=mode==='direct';
    form.querySelectorAll('[data-task-type-label=video]').forEach(n=>n.textContent=mode==='generate'?'AI 视频':'视频原素材');
    document.querySelector('#task-agent-range').hidden=mode!=='select';
    form.elements.rangeFrom.required=mode==='select';form.elements.rangeTo.required=mode==='select';
    form.elements.style.required=!direct;
    form.querySelector('[data-generation-options]').hidden=direct;
    form.elements.separateWriter.disabled=direct;
    form.elements.generationModelId.disabled=direct||!form.elements.separateWriter.checked;
    for(const key of ['sourceMode','useImageText'])form.elements[key].disabled=direct;
    form.elements.noteCard.disabled=mode!=='generate';
    document.querySelector('#task-image-search').hidden=mode!=='generate';
    for(const name of ['imageSearch','imageReferences','searchImageCount','webResearch','maxSearchRequests'])form.elements[name].disabled=mode!=='generate';
    form.elements.videoAspect.closest('label').hidden=mode!=='generate';
    document.querySelector('#task-video-model-choice').hidden=mode!=='generate';
    document.querySelector('#task-mode-help').textContent=direct?'按标题及参考资料中的配文发布原素材，不改写内容；未填配文时使用标题；用户备注不会自动作为正文发布。视频按使用记录轮换，每期一份；文章与图文发布所选图片。':mode==='select'?'agent 按主题、账号定位和用户备注挑选区间内原素材，并生成配文；每期视频一份、图文可多图。':'agent 根据所选素材生成内容；视频成片交给配置的视频模型服务。';
  };
  form.elements.taskMode.onchange=syncMode;syncMode();
  const syncWriterModels=()=>{
    const select=form.elements.generationModelId,value=select.value;
    select.innerHTML=(data.modelSettings.profiles||[]).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+' · '+esc(p.model)+'</option>').join('')||'<option value="">请先保存另一份模型配置</option>';
    if([...select.options].some(o=>o.value===value))select.value=value;
    else if(value){const option=new Option('原选写作配置不可用，请重新选择',value,true,true);select.add(option);}
  };
  bindModelConfig({data,esc,api,toast,onChange:syncWriterModels});
  form.elements.separateWriter.onchange=()=>{form.elements.generationModelId.disabled=!form.elements.separateWriter.checked;};
  form.elements.budget.addEventListener('input',()=>{form.elements.budget.dataset.userEdited='true';});
  const updateSelection=()=>{
    if(!editing&&!form.elements.budget.dataset.userEdited){const targets=[...form.querySelectorAll('[name=target]:checked')];const required=targets.reduce((n,t)=>n+(form.elements.separateWriter.checked?(t.dataset.macroType==='video'?2:3):1)+((form.elements.imageSearch.checked||form.elements.webResearch.checked)&&t.dataset.macroType!=='video'?1:0)+(form.elements.reviewBeforePublish.checked&&t.dataset.macroType!=='video'?1:0),0);form.elements.budget.value=Math.min(32,Math.max(4,required));}
    document.querySelectorAll('[data-task-account]').forEach(card=>card.classList.toggle('is-selected',!!card.querySelector('[name=target]:checked')));
    document.querySelectorAll('.task-source').forEach(card=>card.classList.toggle('is-selected',!!card.querySelector('[name=asset]:checked')));
    document.querySelector('#task-target-count').textContent='已选 '+new Set([...form.querySelectorAll('[name=target]:checked')].map(n=>n.value)).size+' 个账号 · '+form.querySelectorAll('[name=target]:checked').length+' 个发布目标';
    const from=form.elements.rangeFrom.value,to=form.elements.rangeTo.value;
    document.querySelector('#task-source-count').textContent=form.elements.taskMode.value==='select'?'区间内 '+data.assets.filter(a=>/^(image|video)\//.test(a.mime)&&from&&to&&(a.archiveDate||a.created?.slice(0,10))>=from&&(a.archiveDate||a.created?.slice(0,10))<=to).length+' 份候选素材':'已选 '+form.querySelectorAll('[name=asset]:checked').length+' 份素材';
  };
  form.querySelectorAll('[name=target],[name=asset]').forEach(n=>n.onchange=updateSelection);
  form.elements.taskMode.onchange=()=>{syncMode();updateSelection();};
  form.elements.imageSearch.onchange=updateSelection;form.elements.webResearch.onchange=updateSelection;form.elements.reviewBeforePublish.onchange=updateSelection;form.elements.separateWriter.addEventListener('change',updateSelection);
  for(const name of ['rangeFrom','rangeTo'])form.elements[name].addEventListener('input',updateSelection);
  updateSelection();
  document.querySelectorAll('[data-task-platform]').forEach(button=>button.onclick=()=>{
    document.querySelectorAll('[data-task-platform]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
    document.querySelectorAll('[data-task-account]').forEach(card=>card.hidden=!!button.dataset.taskPlatform&&card.dataset.platform!==button.dataset.taskPlatform);
  });
  const filterSources=()=>{
    const q=document.querySelector('#task-source-search').value.trim().toLowerCase(),type=document.querySelector('#task-source-type').value,from=document.querySelector('#task-source-from').value,to=document.querySelector('#task-source-to').value;
    document.querySelectorAll('.task-source').forEach(card=>card.hidden=!!(q&&!card.dataset.sourceName.includes(q)||type&&card.dataset.sourceType!==type||from&&card.dataset.sourceDate<from||to&&card.dataset.sourceDate>to));
    document.querySelector('#task-source-empty').hidden=!!document.querySelector('.task-source:not([hidden])');
  };
  document.querySelector('#task-source-search').oninput=filterSources;document.querySelector('#task-source-type').onchange=filterSources;
  document.querySelectorAll('#task-source-from,#task-source-to').forEach(n=>n.onchange=filterSources);
  document.querySelector('#task-source-clear').onclick=()=>{for(const id of ['task-source-search','task-source-type','task-source-from','task-source-to'])document.getElementById(id).value='';filterSources();};
  const upload=document.querySelector('#task-reference-files');let uploading=false;
  upload.onchange=async()=>{
    const files=[...upload.files];if(!files.length||uploading)return;
    const day=document.querySelector('#task-upload-date').value,status=document.querySelector('#task-upload-status');
    if(!day){toast('请选择上传归档日期');return;}
    uploading=true;upload.disabled=true;form.querySelector('[type=submit]').disabled=true;
    let saved=0;const failures=[];
    try {
      for(const file of files){
        status.textContent='正在保存 '+file.name+'…';
        try {
          if(!/^(image|video)\//.test(file.type)||file.size>512*1024*1024||!file.size)throw Error('请选择不超过 512 MB 的图片或视频');
          const asset=await api('assets',undefined,{method:'POST',headers:{'X-Studio-Token':data.token,'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name),'X-Archive-Date':day},body:file});
          if(!form.isConnected)return;
          const state=await api('state');data.assets=state.assets;
          if(!form.isConnected)return;
          const temp=document.createElement('div');temp.innerHTML=taskScreen({...data,macroTemplates:[]},esc,null);
          const card=[...temp.querySelectorAll('.task-source')].find(c=>c.querySelector('[name=asset]').value===asset.id);
          if(!card)throw Error('已保存，请在素材库查看');
          const checkbox=card.querySelector('[name=asset]');checkbox.checked=true;checkbox.onchange=updateSelection;
          const grid=document.querySelector('.task-source-grid');grid.querySelector('.empty')?.remove();grid.prepend(card);saved++;
        }catch(e){failures.push(file.name+'：'+e.message);}
      }
      if(form.isConnected){updateSelection();filterSources();status.textContent='已保存到素材库并选中 '+saved+' 份素材'+(failures.length?'；'+failures.join('；'):'');}
    } finally {uploading=false;upload.disabled=false;upload.value='';form.querySelector('[type=submit]').disabled=false;}
  };
  const template=id=>data.macroTemplates.find(t=>t.id===id);
  function bind(selector,fn) {
    document.querySelectorAll(selector).forEach(button=>button.onclick=async()=>{
      button.disabled=true;try{await fn(button);}catch(e){toast(e.message);}finally{button.disabled=false;}
    });
  }
  form.onsubmit=async e=>{
    e.preventDefault();if(uploading){toast('请等待参考素材上传完成');return;}const button=form.querySelector('button[type=submit]');button.disabled=true;
    const f=new FormData(form),prior=template(editing);
    const verify=f.has('verify'),maxResends=Number(f.get('resends'));
    if(maxResends && !verify) {toast('启用重发前请勾选创作中心核对');button.disabled=false;return;}
    if(f.get('taskMode')!=='direct'&&f.has('separateWriter')&&!f.get('generationModelId')){toast('请选择写作模型配置');button.disabled=false;return;}
    const durations=f.get('cooldowns').trim();
    const publicationPolicy={...prior?.spec.publicationPolicy,recovery:{...prior?.spec.publicationPolicy?.recovery,visualEnabled:f.has('visualRecovery'),structuredCallsBeforeVisual:Number(f.get('structuredCalls'))},verification:{...prior?.spec.publicationPolicy?.verification,enabled:verify},
      retry:{...prior?.spec.publicationPolicy?.retry,maxResends,allowAbsentAfterTimeout:maxResends>0,
        cooldownSeconds:durations?durations.split(/[,，]/).map(v=>v.trim()===''?null:Number(v.trim())):[]}};
    const spec={...prior?.spec,webResearch:f.has('webResearch'),maxSearchRequests:Number(f.get('maxSearchRequests')||4),editorialReview:true,reviewBeforePublish:f.has('reviewBeforePublish'),imageSearch:{enabled:f.has('imageSearch'),useReferenceImages:f.has('imageReferences'),maxImages:Number(f.get('searchImageCount')||3)},videoModelId:f.get('videoModelId')||null,taskMode:f.get('taskMode'),assetRange:{from:f.get('rangeFrom'),to:f.get('rangeTo')},publicationPolicy,generationModelId:f.get('taskMode')!=='direct'&&f.has('separateWriter')?f.get('generationModelId'):null,sourceMode:f.get('sourceMode')||'description',topic:f.get('topic'),style:f.get('style'),facts:f.get('facts'),assetIds:f.getAll('asset'),noteCard:f.has('noteCard'),videoAspect:f.get('videoAspect'),useImageText:f.has('useImageText'),
      assetNotes:Object.fromEntries([...form.querySelectorAll('[data-asset-note]')].filter(n=>n.value.trim() && f.getAll('asset').includes(n.dataset.assetNote)).map(n=>[n.dataset.assetNote,n.value.trim()])),
      targets:[...form.querySelectorAll('[name=target]:checked')].map(n=>({accountId:n.value,type:n.dataset.macroType})),
      douyinVisibility:f.get('douyinVisibility')||null,mode:f.get('mode'),assetCooldownSeconds:Number(f.get('assetCooldown')),maxMicros:f.get('maxMicros')===''?null:Number(f.get('maxMicros')),maxCalls:Number(f.get('budget')),schedule:readSchedule(form)};
    try{await api('task-templates'+(prior?'/'+prior.id:''),{spec,enabled:prior?.enabled??true,expectedVersion:prior?.version});editing=null;await refresh(true);}
    catch(error){toast(error.message);}finally{button.disabled=false;}
  };
  bind('#macro-new',()=>{editing=null;render();});
  bind('#macro-refresh',()=>refresh(true));
  bind('[data-macro-edit]',b=>{editing=b.dataset.macroEdit;render();});
  bind('[data-macro-toggle]',async b=>{const t=template(b.dataset.macroToggle);await api('task-templates/'+t.id,{spec:t.spec,enabled:!t.enabled,expectedVersion:t.version});await refresh(true);});
  bind('[data-macro-delete]',b=>{
    const t=template(b.dataset.macroDelete);
    openDialog(`<h2>删除已保存任务？</h2><p>${esc(t.spec.topic)}</p><p class="subtle">删除后不再创建新的定时运行。已有运行、生成内容和分发记录会保留，正在执行的任务不会因此停止。</p><p id="delete-template-error" role="alert"></p><div class="task-actions"><button type="button" class="button danger" id="confirm-delete-template">确认删除</button><button type="button" class="button secondary" id="cancel-delete-template">取消</button></div>`);
    document.querySelector('#cancel-delete-template').onclick=()=>document.querySelector('#detail').close();
    document.querySelector('#confirm-delete-template').onclick=async e=>{
      e.target.disabled=true;
      try {await api('task-templates/'+t.id+'/delete',{expectedVersion:t.version});keys.delete(t.id);if(editing===t.id)editing=null;document.querySelector('#detail').close();await refresh(true);toast('已删除任务，历史运行记录已保留');}
      catch(error){document.querySelector('#delete-template-error').textContent=error.message;e.target.disabled=false;}
    };
  });
  bind('[data-macro-run]',async b=>{
    const id=b.dataset.macroRun;
    if(!keys.has(id))keys.set(id,crypto.randomUUID());
    await api('task-templates/'+id+'/run',{requestKey:keys.get(id)});keys.delete(id);await refresh(true);
  });
  bind('[data-macro-details]',async b=>{
    const r=await api('runs/'+b.dataset.macroDetails);
    const view=r=>`<h2>${esc(r.snapshot.topic)}</h2><p>模板版本 ${r.template_version} · 模型调用 ${r.calls} / ${r.snapshot.maxCalls}</p>${r.targets.map(t=>`<p>资料检索请求 ${t.search_calls||0} / ${r.snapshot.maxSearchRequests||4}</p>${t.research_sources?.length?`<details><summary>查看实际检索来源</summary>${t.research_sources.map(source=>`<p>${esc(source.title)} · ${esc(source.date||'日期未提供')}</p><p class="detail-body">${esc(source.url)}<br>${esc(source.summary)}</p>`).join('')}</details>`:''}`).join('')}${(r.videoTasks||[]).map(v=>`<p>视频模型任务 ${esc(v.remote_id||'等待供应商返回任务 ID')} · ${esc(v.status)} · 预留费用 ${v.reserved_micros}</p>`).join('')}${r.targets.map(t=>`<h3>${esc(data.accounts.find(a=>a.id===r.snapshot.targets[t.slot].accountId)?.name||r.snapshot.targets[t.slot].accountId)}</h3><p>${esc(states[t.state])} ${esc(reasons[t.reason]||'')}${t.job?' · 分发状态 '+esc(t.job.state):''}</p>${['missing_generation_model','same_generation_model','vision_required','source_media_limit','source_media_size','missing_model','missing_search_key','domestic_search_unconfigured','account_unavailable','dispatch_validation','insufficient_assets','image_text_failed','card_render_failed','missing_video_model','video_provider_changed','video_call_limit','video_budget_unconfigured','video_provider_failed','video_download_host','video_download_failed','video_too_large','invalid_video_output'].includes(t.reason) ? `<button class="button secondary small" data-resume-target="${t.id}">恢复这个目标</button>` : ''}${t.state==='awaiting_review'?`<button class="button" data-edit-artifact="${t.id}">编辑 / 让agent修改 / 确认发布</button>`:''}${t.draft?`<details><summary>查看保留的外接初稿</summary><p class="detail-body">${esc(t.draft.title||'')}</p><p class="detail-body">${esc(t.draft.body||'')}</p></details>`:''}${t.versions?.length?`<details><summary>查看成品历史版本</summary>${t.versions.map(v=>`<p>版本 ${v.revision} · ${esc(v.note)} · ${esc(v.artifact.title)}</p><p class="detail-body">${esc(v.artifact.body)}</p>`).join('')}</details>`:''}${t.artifact?.reviewNotes?`<details><summary>主agent审改说明</summary><p class="detail-body">${esc(t.artifact.reviewNotes)}</p></details>`:''}${t.artifact?.videoPrompt?`<details><summary>查看视频生成提示词</summary><p class="detail-body">${esc(t.artifact.videoPrompt)}</p></details>`:''}${t.artifact?.generatedVideoId?`<video controls preload="metadata" class="task-video-preview" src="/media/${encodeURIComponent(t.artifact.generatedVideoId)}"></video>`:''}${t.artifact?.generationPrompt?`<details><summary>查看 agent 写作提示词</summary><p class="detail-body">${esc(t.artifact.generationPrompt)}</p></details>`:''}${t.artifact?`${t.artifact.generatedCoverId?`<img src="/media/${encodeURIComponent(t.artifact.generatedCoverId)}" alt="生成的图文首图" width="180" height="240">`:''}<strong>${esc(t.artifact.title)}</strong>${t.artifact.type==='article'?reportPreview(t.artifact):`<p class="detail-body">${esc(t.artifact.body)}</p>`}`:''}`).join('')}${r.targets.some(t=>['pending','generating','card_pending','rendering','ready','awaiting_review','revision_pending','revising','blocked'].includes(t.state))?'<button class="button secondary" id="macro-stop">停止尚未分发的目标</button>':''}`;
    openDialog('<section data-run-progress></section>');
    const root=document.querySelector('[data-run-progress]');
    const draw=r=>{root.innerHTML=view(r);
    bind('[data-edit-artifact]',button=>openArtifactEditor({run:r,target:r.targets.find(t=>t.id===button.dataset.editArtifact),esc,api,openDialog,refresh,toast}));
    bind('[data-resume-target]',async button=>{await api('runs/'+r.id+'/targets/'+button.dataset.resumeTarget+'/resume',{});document.querySelector('#detail').close();await refresh(true);});
    bind('#macro-stop',async()=>{await api('runs/'+r.id+'/stop',{});document.querySelector('#detail').close();await refresh(true);});
    };
    draw(r);watchRunProgress({dialog:document.querySelector('#detail'),root,initial:r,read:signal=>api('runs/'+r.id,undefined,{signal}),render:draw});
  });
}

// Only the mounted read-only run view is refreshed; opening an editor invalidates it.
export function watchRunProgress({dialog,root,initial,read,render,interval=1800}){
  let timer,stopped=false,previous=JSON.stringify(initial);
  const controller=new AbortController();
  const current=()=>!stopped&&dialog.open&&root.isConnected;
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(timer);controller.abort();observer.disconnect();dialog.removeEventListener('close',stop);window.removeEventListener('hashchange',stop);};
  const observer=new MutationObserver(()=>{if(!root.isConnected)stop();});
  observer.observe(root.parentElement,{childList:true});dialog.addEventListener('close',stop);window.addEventListener('hashchange',stop);
  async function poll(){
    if(!current()){stop();return;}
    try{
      const result=await read(controller.signal);if(!current())return;
      const serialized=JSON.stringify(result);
      if(serialized!==previous&&!root.querySelector('button:disabled')){
        const scroll=dialog.scrollTop,expanded=new Set([...root.querySelectorAll('details[open]')].map(n=>n.querySelector('summary')?.textContent));
        const videos=new Map([...root.querySelectorAll('video')].map(n=>[n.getAttribute('src'),n]));
        render(result);previous=serialized;
        for(const d of root.querySelectorAll('details'))if(expanded.has(d.querySelector('summary')?.textContent))d.open=true;
        for(const video of root.querySelectorAll('video')){const old=videos.get(video.getAttribute('src'));if(old)video.replaceWith(old);}
        dialog.scrollTop=scroll;
      }
      root.querySelector('[data-run-poll-status]')?.remove();
    }catch{
      if(current()&&!root.querySelector('[data-run-poll-status]')){const message=document.createElement('p');message.dataset.runPollStatus='true';message.setAttribute('role','status');message.textContent='进度暂未更新，正在重试连接…';root.append(message);}
    }finally{if(current())timer=setTimeout(poll,interval);else stop();}
  }
  timer=setTimeout(poll,interval);return stop;
}
