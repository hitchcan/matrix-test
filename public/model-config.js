export function modelForm(model,esc,selectedId=model.activeId) {
  const profile=model.profiles?.find(p=>p.id===selectedId)||model;
  return `<p class="subtle">选择 agent 使用的模型；任务可另选写作 LLM。支持 Chat Completions 兼容接口，视频成片使用独立视频服务。</p><form id="model-settings-form" class="task-fields" data-profile-id="${esc(profile.configured?profile.id:'')}">
  <label class="field task-wide">已保存的配置<select id="model-profile-select"><option value="">新建配置</option>${(model.profiles||[]).map(p=>`<option value="${esc(p.id)}" ${profile.id===p.id?'selected':''}>${esc(p.name)} · ${esc(p.model)}${p.id===model.activeId?'（当前 agent）':''}</option>`).join('')}</select></label>
  <label class="field">配置名称<input name="name" maxlength="100" value="${esc(profile.name||'')}" placeholder="例如：agent 规划模型 / 文章写作模型"></label><label class="field">模型名称<input name="model" value="${esc(profile.model)}" required></label>
  <label class="field task-wide">完整接口地址<input name="endpoint" type="url" value="${esc(profile.endpoint)}" placeholder="https://服务地址/v1/chat/completions" required></label>
  <label class="field">API Key<input name="key" type="password" autocomplete="new-password" placeholder="${profile.hasKey?'已保存，留空保留；更换地址需重新填写':'本地服务可留空'}"></label><label class="task-check"><input name="vision" type="checkbox" ${profile.vision?'checked':''}> 模型支持图片输入</label>
  <label class="task-check"><input name="clearKey" type="checkbox">清除已保存密钥</label><div class="task-actions task-wide"><button class="button secondary" type="submit">保存模型配置</button><button class="button secondary" type="button" id="model-new">新建配置</button><button class="button secondary" type="button" id="model-activate" ${profile.configured?'':'disabled'}>设为 agent 模型</button><button class="button" type="button" id="model-test">保存并测试连接</button></div></form><p id="model-test-result" role="status" class="subtle"></p><small class="subtle">测试会发送一次短请求，供应商可能计费；不发送任务资料。密钥仅保存在本机，接口不返回密钥。</small>`;
}

export function bindModelConfig({data,esc,api,toast,onChange}) {
  function show(id,message='') {
    if(!document.querySelector('.task-model'))return;
    document.querySelector('.task-model .panel-body').innerHTML=modelForm(data.modelSettings,esc,id);
    document.querySelector('#model-test-result').textContent=message;
    const badge=document.querySelector('.task-model .badge');badge.textContent=data.modelSettings.configured?'已配置':'待配置';badge.className='badge '+(data.modelSettings.configured?'green':'amber');
    bind();onChange?.();
  }
  function bind() {
    const form=document.querySelector('#model-settings-form'),select=document.querySelector('#model-profile-select');
    const status=document.querySelector('#model-test-result');
    select.onchange=()=>{
      if(select.value)show(select.value);
      else {const empty={profiles:data.modelSettings.profiles,activeId:data.modelSettings.activeId};document.querySelector('.task-model .panel-body').innerHTML=modelForm(empty,esc,'');bind();}
    };
    document.querySelector('#model-new').onclick=()=>{select.value='';select.onchange();};
    async function save() {
      if(!form.reportValidity())return null;
      const f=new FormData(form),id=form.dataset.profileId;
      const result=await api('model-settings',{...(id?{id}:{create:true}),activate:!data.modelSettings.configured,name:f.get('name'),endpoint:f.get('endpoint'),model:f.get('model'),key:f.get('key'),vision:f.has('vision'),clearKey:f.has('clearKey')});
      data.modelSettings=result;return result.savedId;
    }
    async function act(fn) {
      const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
      try {await fn();}catch(e){status.textContent=e.message;toast(e.message);}finally{buttons.forEach(b=>b.disabled=false);}
    }
    form.onsubmit=e=>{e.preventDefault();void act(async()=>{const id=await save();if(id){show(id,'配置已保存');toast('模型配置已保存，后续调用生效');}});};
    document.querySelector('#model-activate').onclick=()=>void act(async()=>{
      if(!form.dataset.profileId){toast('请先保存配置');return;}
      data.modelSettings=await api('model-settings/select',{id:form.dataset.profileId});show(data.modelSettings.activeId,'已设为 agent 模型');
    });
    document.querySelector('#model-test').onclick=()=>void act(async()=>{
      const id=await save();if(!id)return;
      status.textContent='正在测试连接（最长 20 秒）…';
      try {const result=await api('model-settings/test',{id});show(id,result.message+' · '+result.latencyMs+' ms');}
      catch(e){show(id,e.message);}
    });
  }
  bind();
}
