const PROVIDERS={wan3:'阿里云百炼 · 万相3.0（业务空间）',tokenplan:'阿里云百炼 · Token Plan',json:'其他服务 · JSON 异步网关'};
const VIDEO_SUFFIX='/api/v1/services/aigc/video-generation/video-synthesis';
const REGIONS=[['cn-beijing','北京'],['ap-southeast-1','新加坡'],['ap-northeast-1','东京'],['eu-central-1','法兰克福'],['us-east-1','弗吉尼亚'],['cn-hongkong','中国香港']];
const MODEL_PRESETS={wan3:['wan3.0-video','wan3.0-video-prime','wan2.6-t2v','wan2.5-t2v-preview'],tokenplan:['happyhorse-1.1-t2v','happyhorse-1.1-i2v','happyhorse-1.1-r2v','wan3.0-video'],json:[]};
const durationBounds=provider=>provider==='tokenplan'?[3,15]:[2,30];
function durationOptions(provider,value){
  const [min,max]=durationBounds(provider),current=Math.min(Math.max(Math.round(Number(value)||5),min),max);
  return Array.from({length:max-min+1},(_,i)=>min+i).map(n=>`<option value="${n}" ${n===current?'selected':''}>${n} 秒</option>`).join('');
}
export function videoForm(settings={},esc,selectedId=settings.activeId){
  const p=settings.profiles?.find(p=>p.id===selectedId)||(selectedId&&settings.configured?settings:{});
  const provider=PROVIDERS[p.provider]?p.provider:'wan3';
  return `<p class="subtle">视频生成服务独立于 agent 的文本模型。可保存多份配置，任务内选择；支持百炼万相（业务空间）、百炼 Token Plan 套餐和统一 JSON 异步网关。同一把密钥可通过修改模型名称调用该套餐内的不同视频模型。</p><form id="video-settings-form" class="task-fields" data-profile-id="${esc(p.id==='environment'?'':p.id)}">
  <label class="field task-wide">已保存的视频配置<select id="video-profile-select"><option value="">新建配置</option>${(settings.profiles||[]).map(v=>`<option value="${esc(v.id)}" ${v.id===p.id?'selected':''}>${esc(v.name)} · ${esc(v.model)}${v.id===settings.activeId?'（默认）':''}</option>`).join('')}</select></label>
  <label class="field">配置名称<input name="name" maxlength="100" value="${esc(p.name||'')}" placeholder="例如：Token Plan 北京"></label><label class="field">供应商协议<select name="provider">${Object.entries(PROVIDERS).map(([id,name])=>`<option value="${id}" ${provider===id?'selected':''}>${name}</option>`).join('')}</select></label>
  <div class="task-wide task-fields" id="video-wan-endpoint"><label class="field">百炼地域<select id="video-region">${REGIONS.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></label><label class="field">业务空间 Workspace ID<input id="video-workspace" placeholder="万相填业务空间ID；Token Plan 固定为 token-plan"></label><button type="button" class="button secondary small" id="video-build-endpoint">填写视频接口地址</button></div>
  <label class="field task-wide">完整生成接口地址<input type="url" name="endpoint" value="${esc(p.endpoint||'')}" required placeholder="https://业务空间.cn-beijing.maas.aliyuncs.com${VIDEO_SUFFIX}"></label>
  <label class="field">视频模型名称<input name="model" value="${esc(p.model||'wan3.0-video')}" required maxlength="200" placeholder="可直接填写模型ID"><span class="subtle">列表仅为常用预设；业务空间已开通的文生视频模型可直接填模型 ID</span></label><label class="field" id="video-model-presets-row">常用模型<select id="video-model-pick"><option value="">选择后填入左侧</option>${(MODEL_PRESETS[provider]||[]).map(n=>`<option value="${n}">${n}</option>`).join('')}</select></label><label class="field">视频 API Key<input type="password" name="key" autocomplete="new-password" placeholder="${p.hasKey?'已保存，留空保留；更换供应商或地址需重新填写':'万相填业务空间密钥；Token Plan 填 sk-sp- 开头的套餐密钥'}"></label>
  <label class="field">生成时长<select name="duration">${durationOptions(provider,p.duration||5)}</select></label><label class="field">分辨率<select name="resolution">${['480P','720P','1080P'].map(r=>`<option value="${r}" ${r===(p.resolution||'720P')?'selected':''}>${r}</option>`).join('')}</select></label>
  <label class="task-check" id="video-audio-row"><input type="checkbox" name="audio" ${p.audio!==false?'checked':''}>生成声音<span class="subtle">（Token Plan 按官方参数不提交声音开关）</span></label><label class="task-check"><input type="checkbox" name="clearKey">清除已保存的视频密钥</label>
  <label class="field">每次运行最多生成视频次数<select name="maxGenerations">${Array.from({length:32},(_,i)=>i+1).map(n=>`<option value="${n}" ${n===(p.maxGenerations||4)?'selected':''}>${n} 次</option>`).join('')}</select></label><label class="field">允许下载的额外域名<input name="downloadHosts" value="${esc(p.downloadHosts||'')}" placeholder="网关结果域名，逗号分隔；百炼结果域名已内置"></label>
  <details class="task-wide"><summary>可选费用估算上限</summary><div class="task-fields"><label class="field">单次预留费用（百万分之一计价单位）<input type="number" min="1" name="callMicros" value="${p.callMicros||''}"></label><label class="field">每次运行费用上限（同一单位）<input type="number" min="1" name="maxMicros" value="${p.maxMicros||''}"></label></div><p class="subtle">可同时留空，仅按次数限制执行；实际收费以供应商账单为准。</p></details>
  <div class="task-actions task-wide"><button class="button" type="submit">保存视频配置</button><button type="button" class="button secondary" id="video-new">新建视频配置</button><button type="button" class="button secondary" id="video-activate" ${p.configured?'':'disabled'}>设为默认视频模型</button><button type="button" class="button secondary" id="video-check">保存并检查配置</button></div></form><p id="video-config-status" class="subtle" role="status"></p><small class="subtle">配置检查仅在本地校验，不会生成视频。运行 AI 视频任务会调用生成服务并可能计费；密钥仅保存在本机，不返回页面。万相需使用「业务空间 + 地域」的地址与该空间密钥；Token Plan 使用 https://token-plan.地域.maas.aliyuncs.com 的地址与 sk-sp- 套餐密钥，两者不可混用。</small>`;
}
export function bindVideoConfig({data,esc,api,toast,onChange}){
  const root=document.querySelector('#video-config-body');if(!root)return;
  const show=(id,message='')=>{root.innerHTML=videoForm(data.videoSettings,esc,id);root.querySelector('#video-config-status').textContent=message;bind();onChange?.();};
  function bind(){
    const form=root.querySelector('form'),status=root.querySelector('#video-config-status'),profile=root.querySelector('#video-profile-select');
    const provider=()=>form.elements.provider.value,asyncVideo=()=>provider()!=='json';
    const workspace=root.querySelector('#video-workspace'),region=root.querySelector('#video-region'),endpoint=form.elements.endpoint;
    const modelInput=form.elements.model,modelPicker=root.querySelector('#video-model-pick');
    let helperEdited=false;
    const syncModels=()=>{
      const list=MODEL_PRESETS[provider()]||[];
      root.querySelector('#video-model-presets-row').hidden=!list.length;
      modelPicker.innerHTML='<option value="">选择后填入左侧</option>'+list.map(m=>`<option value="${m}">${m}</option>`).join('');
      const current=modelInput.value.trim();
      const knownElsewhere=Object.values(MODEL_PRESETS).some(names=>names.includes(current));
      if(list.length&&(!current||(knownElsewhere&&!list.includes(current))))modelInput.value=list[0];
      modelPicker.value=list.includes(modelInput.value)?modelInput.value:'';
    };
    modelPicker.onchange=()=>{if(modelPicker.value)modelInput.value=modelPicker.value;};
    const syncProvider=()=>{
      root.querySelector('#video-wan-endpoint').hidden=!asyncVideo();
      root.querySelector('#video-audio-row').hidden=provider()==='tokenplan';
      workspace.readOnly=provider()==='tokenplan';
      if(provider()==='tokenplan')workspace.value='token-plan';
      else if(workspace.value==='token-plan')workspace.value='';
      const select=form.elements.duration,current=Number(select.value)||5,[min,max]=durationBounds(provider());
      select.innerHTML=Array.from({length:max-min+1},(_,i)=>min+i).map(n=>`<option value="${n}">${n} 秒</option>`).join('');
      select.value=String(Math.min(Math.max(current,min),max));
      syncModels();
    };
    const readEndpoint=()=>{
      helperEdited=false;workspace.value='';
      try{const match=new URL(endpoint.value).hostname.match(/^([a-z0-9-]+)\.(.+)\.maas\.aliyuncs\.com$/);if(match){workspace.value=match[1];region.value=match[2];}}
      catch{}
      if(provider()==='tokenplan')workspace.value='token-plan';
    };
    const buildEndpoint=(report=false)=>{
      const id=provider()==='tokenplan'?'token-plan':workspace.value.trim();
      if(!/^[a-z0-9-]+$/i.test(id)||!region.value){if(report)toast(provider()==='tokenplan'?'请选择 Token Plan 地域':'请填写有效的业务空间ID并选择地域');return false;}
      endpoint.value='https://'+id+'.'+region.value+'.maas.aliyuncs.com'+VIDEO_SUFFIX;return true;
    };
    syncProvider();readEndpoint();endpoint.addEventListener('input',readEndpoint);
    workspace.addEventListener('input',()=>{helperEdited=true;buildEndpoint();});
    region.addEventListener('change',()=>{helperEdited=true;buildEndpoint();});
    form.elements.provider.onchange=()=>{helperEdited=true;syncProvider();if(asyncVideo())buildEndpoint();};
    root.querySelector('#video-build-endpoint').onclick=()=>{helperEdited=true;buildEndpoint(true);};
    profile.onchange=()=>show(profile.value);root.querySelector('#video-new').onclick=()=>show('');
    async function save(){if(asyncVideo()&&helperEdited&&!buildEndpoint(true))return null;if(!form.reportValidity())return null;const f=new FormData(form),id=form.dataset.profileId;const settings=await api('video-settings',{...(id?{id}:{create:true}),activate:!data.videoSettings?.configured,name:f.get('name'),provider:f.get('provider'),endpoint:f.get('endpoint'),model:f.get('model'),key:f.get('key'),clearKey:f.has('clearKey'),audio:f.has('audio'),duration:Number(f.get('duration')),resolution:f.get('resolution'),downloadHosts:f.get('downloadHosts'),maxGenerations:Number(f.get('maxGenerations')),callMicros:f.get('callMicros')?Number(f.get('callMicros')):0,maxMicros:f.get('maxMicros')?Number(f.get('maxMicros')):null});data.videoSettings=settings;return settings.savedId;}
    async function act(fn){const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){status.textContent=e.message;toast(e.message);}finally{buttons.forEach(b=>b.disabled=false);}}
    form.onsubmit=e=>{e.preventDefault();void act(async()=>{const id=await save();if(id)show(id,'视频配置已保存');});};
    root.querySelector('#video-check').onclick=()=>void act(async()=>{const id=await save();if(id){const result=await api('video-settings/check',{id});show(id,result.message);}});
    root.querySelector('#video-activate').onclick=()=>void act(async()=>{data.videoSettings=await api('video-settings/select',{id:form.dataset.profileId||profile.value});show(data.videoSettings.activeId,'已设为默认视频模型');});
  }
  bind();
}
