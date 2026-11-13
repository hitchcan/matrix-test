import {macroScreen,bindMacros} from './macro.js';
import {mountEditor,safeHtml} from '/editor.bundle.js';
const $ = s => document.querySelector(s);
let editors=[];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const names = { zhihu: '知乎', bilibili: '哔哩哔哩', xhs: '小红书', douyin:'抖音' };
const icons = { zhihu: '知', bilibili: '哔', xhs: '红', douyin:'抖' };
const types = { video: '视频', article: '长文章', note: '图片笔记' };
const states = { waiting_human:'等待本人处理', recovering:'模型恢复中', queued: '待执行', uploading: '上传准备中', awaiting_confirmation: '待人工核对', submitting: '提交中', needs_verification:'等待人工验证', demo_submitted: '演示已提交', needs_login: '需恢复会话', unknown: '结果待确认', cancelled: '已取消', manually_closed: '已人工关闭', opening_settings:'打开发布设置中',blocked: '已阻断', needs_manual: '需人工处理', identity_mismatch: '身份不一致', submitted: '平台已提交' };
let data = { accounts: [], assets: [], jobs: [], drafts: [] };
let page = location.hash.slice(1) || 'compose';
let form = { type: 'video', title: '', body: '', assetIds: [], versions: {}, publication:{mode:'manual',aiAssisted:null,silent:true} };
const accountPlatforms = ['douyin','bilibili','zhihu','xhs'];
let accountPlatform = '';
let addingAccount = false;
let targetPlatform = '';
let selected = ['demo-zhihu', 'demo-bilibili'];
let requestKey = crypto.randomUUID();
let previewPlatform = 'zhihu';
let draftId = null;
let uploading = false;
const localDay = value => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(value ? new Date(value) : new Date());
const assetDay = a => a.archiveDate || localDay(a.created);
let library = {date:'', type:'', search:'', order:'desc', uploadDate:localDay()};
let submitting = false;
let toastTimer;
let modalJob = null;
const icon = p => `<span class="platform-icon ${p}">${icons[p]}</span>`;
const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const size = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const badge = state => `<span class="badge ${state === 'demo_submitted' ? 'green' : ['unknown', 'needs_login', 'awaiting_confirmation','needs_verification'].includes(state) ? 'amber' : state === 'blocked' ? 'red' : 'blue'}">${states[state]}</span>`;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4200); }
async function api(path, body, options = {}) {
  const res = await fetch(`/api/${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': data.token }, body: JSON.stringify(body) }), ...options });
  const result = await res.json();
  if (!res.ok) { const err = new Error(result.error || '操作失败'); err.status = res.status; err.issues = result.issues; throw err; }
  return result;
}
async function refresh(renderPage = false) {
  try {
    const before=JSON.stringify([data.accounts,data.capabilities]);
    data = await api('state');
    let updateNotice=$('#service-update');
    if(!updateNotice){updateNotice=document.createElement('div');updateNotice.id='service-update';updateNotice.className='notice service-update';updateNotice.setAttribute('role','alert');$('#main').before(updateNotice);}
    updateNotice.hidden=!!data.capabilities?.accountDeletion;
    updateNotice.textContent='当前后台服务版本较旧，尚不支持删除账号。请在启动窗口按 Ctrl+C 停止服务，再运行“启动展示.cmd”并刷新页面；仅刷新页面不会更新后台服务。';
    selected=selected.filter(id=>data.accounts.some(a=>a.id===id));
    $('.local-badge').classList.remove('connection-offline');
    $('.local-badge').innerHTML = '<span class="dot"></span>本地服务在线';
    $('#nav-count').textContent = data.jobs.filter(j => ['queued', 'uploading', 'awaiting_confirmation', 'needs_verification', 'submitting', 'unknown', 'needs_login'].includes(j.state)).length;
    if (renderPage || page === 'tasks') render();
    else if(page==='accounts' && before!==JSON.stringify([data.accounts,data.capabilities])){
      const temp=document.createElement('div');temp.innerHTML=renderAccounts();
      $('#account-browser').replaceWith(temp.querySelector('#account-browser'));bindAccountActions();
    }
    document.querySelectorAll('[data-account-state]').forEach(el=>{const a=data.accounts.find(a=>a.id===el.dataset.accountState);if(a)el.textContent=names[a.platform]+' · '+(a.mode==='demo'?'演示账号':a.status==='connected'?'已登录，可发布':'正在等待/识别登录');});
    if (modalJob && $('#detail').open) renderJob(modalJob);
  } catch (e) { $('.local-badge').textContent = '本地服务离线'; $('.local-badge').classList.add('connection-offline'); if (renderPage) toast(e.message); }
}
function heading(eyebrow, title, subtitle, actions = '') { return `<div class="eyebrow">${eyebrow}</div><div class="page-heading"><div><h1>${title}</h1><p class="intro">${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`; }
function notice() { return '<div class="notice"><span class="notice-icon">◈</span><span><strong>本地浏览器发布工作流</strong>　演示账号仅模拟；真实账号上传到官方后台，按你选择的方式提交。小红书支持视频与图片笔记；抖音支持视频发布。</span><span class="badge outline">LOCAL MODE</span></div>'; }
function field(label, name, value, placeholder = '', textarea = false) { return `<label class="field"><span class="label">${label}</span>${textarea ? `<textarea data-field="${name}" placeholder="${placeholder}">${esc(value)}</textarea>` : `<input type="text" data-field="${name}" value="${esc(value)}" placeholder="${placeholder}">`}</label>`; }
function bodyField(label,path,text){return form.type==='article'?`<div class="field"><div class="label">${label}</div><div data-rich="${path}"></div><p class="subtle">支持 Word 粘贴 / .docx 导入；平台可能调整字体与版式。页眉页脚、浮动对象不保留。</p></div>`:field(label,path,text,'分享你的故事、观点，或视频背后的灵感……',true);}
function renderCompose() {
  form.publication ||= {mode:'manual',aiAssisted:null,silent:true};
  selected=selected.filter(id=>{const a=data.accounts.find(a=>a.id===id);return a&&data.platforms[a.platform]?.types.includes(form.type);});
  if(!data.platforms[previewPlatform]?.types.includes(form.type))previewPlatform=['zhihu','bilibili','xhs','douyin'].find(p=>data.platforms[p]?.types.includes(form.type))||'zhihu';
  return heading('CREATE ONCE, DISTRIBUTE WITH CARE', '让好内容，<span>有序抵达。</span>', '从一个想法，到多个平台。在这里完成你的下一次创作。', '<button class="button secondary" id="open-drafts">▱ 草稿箱 <span class="muted">'+data.drafts.length+'</span></button><button class="button secondary" id="save-draft">保存草稿</button>') + notice() + `
  <div class="compose-layout"><section class="panel"><div class="panel-head"><h2><span class="step">01</span>创作内容</h2><small>你的创作，由你掌握</small></div><div class="panel-body">
  <div class="content-tabs" role="tablist" aria-label="内容类型">${Object.entries(types).map(([v, n]) => `<button role="tab" aria-selected="${form.type === v}" data-type="${v}" class="${form.type === v ? 'selected' : ''}">${v === 'video' ? '▷' : v === 'article' ? '▤' : '▧'}　${n}</button>`).join('')}</div>
  ${field('<span>内容标题 <span class="required">*</span></span><small>统一标题，可按平台调整</small>', 'title', form.title, '给这次创作一个好标题')}
  ${bodyField('正文 / 视频简介 <small>保留你的表达</small>','body',form.body)}
  <div class="label">${form.type === 'video' ? '视频素材' : '配图素材'}<small>文件保存到本地素材库</small></div>
  <label class="upload"><span class="upload-icon">↥</span><strong>${uploading ? '正在保存素材…' : '点击上传，或将素材拖放至此'}</strong><small>图片或视频 · 单文件不超过 512 MB（展示版限制）</small><input id="upload" type="file" multiple accept="image/*,video/*" ${uploading ? 'disabled' : ''}></label>
  <div class="asset-chips">${form.assetIds.map(assetId => { const a = data.assets.find(a => a.id === assetId); return a ? `<span class="chip"><span>${esc(a.name)}</span><button data-remove-asset="${a.id}" aria-label="移除素材 ${esc(a.name)}">×</button></span>` : ''; }).join('')}</div>
  <button class="button ghost small" id="choose-assets" ${data.assets.length ? '' : 'disabled'}>从素材库选择</button>
  ${form.type==='video'?`<div class="field"><span class="label">B站视频封面 <small>仅用于B站</small></span><select data-field="coverAssetId" aria-label="B站视频封面"><option value="">在B站后台手动设置</option>${data.assets.filter(a=>/^image\/(png|jpeg)$/.test(a.mime)).map(a=>`<option value="${a.id}" ${form.coverAssetId===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select><label class="button secondary small cover-upload-choice">上传封面图片<input aria-label="上传B站封面图片" id="cover-upload" type="file" accept="image/png,image/jpeg" ${uploading?'disabled':''}></label><p class="subtle">支持PNG/JPEG，建议不小于1200×900。未选择封面时，任务会在最终投稿前暂停，等你去后台补充。</p></div>`:''}
  <details class="platform-edits"><summary>平台文案微调 <span class="muted">　独立标题与正文</span></summary><p class="subtle">未填写时使用统一文案。长文章对应知乎文章 / B站专栏。</p>${['zhihu','bilibili','xhs','douyin'].filter(p=>data.platforms[p]?.types.includes(form.type)).map(p => `<div class="platform-edits-title">${names[p]}</div>${field('标题', `versions.${p}.title`, form.versions[p]?.title || '', '使用统一标题')}${bodyField(names[p]+'正文',`versions.${p}.body`,form.versions[p]?.body||'')}`).join('')}</details>
  </div><div class="editor-bottom"><span>◉　内容和素材存储在本机</span><span>${draftId ? '正在编辑已保存草稿' : '尚未保存为草稿'}</span></div></section>
  <div class="right-column"><section class="panel"><div class="panel-head"><h2><span class="step">02</span>选择分发账号</h2><a href="#accounts" class="muted">管理 ↗</a></div><div class="panel-body">
  <label class="label target-platform-filter">按平台选择账号<select id="target-platform" aria-label="发布账号平台"><option value="">全部平台</option>${accountPlatforms.map(p=>`<option value="${p}" ${targetPlatform===p?'selected':''}>${names[p]}（${data.accounts.filter(a=>a.platform===p).length}）</option>`).join('')}</select></label>
  ${data.accounts.filter(a=>!targetPlatform||a.platform===targetPlatform).map(a => `<label class="target-row">${icon(a.platform)}<span class="target-copy"><strong>${esc(a.name)}</strong><small data-account-state="${a.id}">${names[a.platform]} · ${a.mode === 'demo' ? '演示账号' : (a.status === 'connected' ? '身份已核验' : '待登录 / 核验')}</small></span><input aria-label="选择 ${esc(a.name)}" type="checkbox" data-account="${a.id}" ${selected.includes(a.id) ? 'checked' : ''} ${data.platforms[a.platform]?.types.includes(form.type)?'':'disabled'}></label>`).join('') || '<p class="subtle">当前平台暂无账号，请前往账号管理添加。</p>'}
  <p class="subtle">切换平台会保留已选账号，可跨平台选择。</p>
  <p class="subtle">小红书：视频 / 图片笔记；抖音：视频发布。知乎支持创作声明下拉菜单。</p></div></section>
  <section class="panel"><div class="panel-head"><h2><span class="step">03</span>内容预览</h2><small>示意排版</small></div><div class="panel-body"><div class="preview-tabs">${['zhihu','bilibili','xhs','douyin'].filter(p=>data.platforms[p]?.types.includes(form.type)).map(p => `<button data-preview="${p}" class="${p === previewPlatform ? 'selected' : ''}">${names[p]}</button>`).join('')}</div><div id="preview"></div><div class="preview-foot">平台最终排版以创作者后台为准</div></div></section></div></div>
  <section class="panel publication-panel"><div class="panel-head"><h2>发布选项</h2><small>选项随草稿和每次任务保存</small></div><div class="panel-body publication-options">
  <label><span class="label">发布方式</span><select id="publication-mode" aria-label="发布方式"><option value="manual" ${form.publication.mode==='manual'?'selected':''}>发布前人工处理</option><option value="auto" ${form.publication.mode==='auto'?'selected':''}>工具直接完成发布</option></select></label>
  <label><input id="recover-prepare" type="checkbox" ${form.publicationPolicy?.recovery?.enabled!==false?'checked':''}> 准备异常时由模型恢复</label>
  <label><input id="recover-visual" type="checkbox" ${form.publicationPolicy?.recovery?.visualEnabled?'checked':''}> 结构化恢复后启用任务目标约束的账号页视觉操作（需视觉模型）</label><label><span class="label">升级视觉前最多结构化调用次数</span><input id="recover-structured" type="number" min="1" max="32" value="${form.publicationPolicy?.recovery?.structuredCallsBeforeVisual??2}"></label>
  <label><input id="creator-check" type="checkbox" ${form.publicationPolicy?.verification?.enabled?'checked':''}> 提交后核对创作中心</label>
  ${form.publicationPolicy?.verification?.enabled ? `<label><span class="label">有效缺席后最多重发次数（0 关闭）</span><input id="retry-limit" type="number" min="0" max="100" step="1" value="${esc(String(form.publicationPolicy.retry?.maxResends ?? 0))}"></label>
  <label><span class="label">各次重发冷却（秒，逗号分隔）</span><input id="retry-delays" placeholder="1800,7200" value="${esc((form.publicationPolicy.retry?.cooldownSeconds || []).join(','))}"></label>
  ${[['firstCheckAfterSeconds','首次核对延迟（秒）',180],['checkIntervalSeconds','有效核对间隔（秒）',300],['absenceWindowSeconds','缺席观察窗口（秒）',1800],['requiredValidChecks','最少有效核对次数',3],['maxObserveDurationSeconds','最长观察时间（秒）',86400]].map(([key,label,initial])=>`<label><span class="label">${label}</span><input data-verification="${key}" type="number" min="${key==='firstCheckAfterSeconds'?0:1}" step="1" value="${esc(String(form.publicationPolicy.verification[key] ?? initial))}"></label>`).join('')}
  <p class="subtle">自动发布任务在核对账号、覆盖全部稿件状态并完成最后查重后才可重发。手工发布任务保留人工处理。</p>` : ''}
  <label><span class="label">平台 AI 辅助创作声明</span><select id="publication-ai" aria-label="平台 AI 辅助创作声明"><option value="" ${typeof form.publication.aiAssisted!=='boolean'?'selected':''}>请选择是否勾选</option><option value="yes" ${form.publication.aiAssisted===true?'selected':''}>勾选 AI 辅助创作</option><option value="no" ${form.publication.aiAssisted===false?'selected':''}>不勾选 AI 辅助创作</option></select></label>
  <label><span class="label">抖音视频可见范围</span><select id="publication-douyin-visibility"><option value="">沿用平台当前设置</option><option value="public" ${form.publication.douyinVisibility==='public'?'selected':''}>公开</option><option value="private" ${form.publication.douyinVisibility==='private'?'selected':''}>仅自己可见</option></select></label><label class="silent-choice"><input id="publication-silent" type="checkbox" aria-label="静默执行自动发布" ${form.publication.silent!==false?'checked':''} ${form.publication.mode!=='auto'?'disabled':''}> 后台执行自动发布（抖音保留最小化窗口供人工验证）</label><p id="publication-help" class="subtle"></p></div></section>
  <div id="issues"></div><div class="publish-bar"><div><strong id="selection-count">已选择 ${selected.length} 个账号</strong><small id="publication-summary"></small></div><div class="publish-controls"><select id="scenario" aria-label="演示场景"><option value="normal">正常流程</option><option value="login">演示：会话失效</option><option value="unknown">演示：提交结果不明</option></select><button class="button secondary" id="validate">校验内容</button><button class="button" id="dispatch" ${uploading || submitting ? 'disabled' : ''}>${form.publication.mode==='auto'?'创建并直接发布':'创建分发任务'} <span>↗</span></button></div></div>`;
}
function updatePublicationSummary(){
  if(!$('#publication-help'))return;
  const auto=form.publication?.mode==='auto';
  $('#publication-help').textContent=auto?'点击“创建并直接发布”后，工具会按所选账号和文案执行最终提交；遇到必填项、验证或声明控件无法确认时转人工处理。':'工具填写后暂停，供你处理封面、分区等必填项，再由你确认提交。最终提交前会重新设置并检查所选 AI 声明。';
  if(form.publication?.aiAssisted===false && selected.some(id=>data.accounts.some(a=>a.id===id&&a.platform==='zhihu'&&a.mode!=='demo')))$('#publication-help').textContent+=' 知乎将核对声明；已勾选AI时选择“无声明”。控件缺失时仍可不添加声明继续。';
  if(form.publication?.aiAssisted===false && selected.some(id=>data.accounts.some(a=>a.id===id&&['douyin','bilibili'].includes(a.platform)&&a.mode!=='demo')))$('#publication-help').textContent+=' 抖音默认未声明时直接继续；B站声明为空时选择“内容无需标注”，满足必填要求。明确已有AI声明时才尝试取消。';
  $('#publication-silent').disabled=!auto;
  $('#publication-summary').textContent=auto?'准备完成即提交 · 演示账号仍仅模拟':'每个账号独立执行 · 提交前等待人工处理';
  $('#dispatch').innerHTML=(auto?'创建并直接发布':'创建分发任务')+' <span>↗</span>';
}
function updatePreview() {
  if (!$('#preview')) return;
  const v = form.versions[previewPlatform] || {}; const asset = data.assets.find(a => form.assetIds.includes(a.id));
  $('#preview').innerHTML = `<div class="preview"><div class="preview-top">${icon(previewPlatform)}<span>你的${names[previewPlatform]}创作</span><span class="badge">${types[form.type]}</span></div><div class="preview-image">${asset ? asset.mime.startsWith('video/') ? `<video muted preload="metadata" src="/media/${asset.id}"></video>` : `<img alt="素材预览" src="/media/${asset.id}">` : '<span>CREATE & SHARE</span>'}</div><div class="preview-title">${esc(v.title || form.title || '下一篇好内容，从这里开始')}</div><div class="preview-body">${form.type==='article' ? safeHtml((v.body?v.bodyHtml:form.bodyHtml)||esc(v.body||form.body)) : esc(v.body||form.body||'你的故事，值得被更多人看见。')}</div></div>`;
}
function renderTasks() {
  const count = s => data.jobs.filter(j => s.includes(j.state)).length;
  return heading('EVERY STEP, IN VIEW', '分发任务', '每个账号，一条独立的轨迹。查看进度，核对内容，再继续。', '<a class="button" href="#compose">＋ 创建内容</a>') + notice() + `<div class="stats"><div class="stat"><small>全部任务</small><strong>${data.jobs.length.toString().padStart(2,'0')}</strong><span>独立账号任务</span></div><div class="stat"><small>等待你处理</small><strong>${count(['awaiting_confirmation','needs_verification', 'unknown', 'needs_login', 'needs_manual', 'identity_mismatch']).toString().padStart(2,'0')}</strong><span>人工核对与接管</span></div><div class="stat"><small>演示已提交</small><strong>${count(['demo_submitted']).toString().padStart(2,'0')}</strong><span>不代表真实发布</span></div><div class="stat"><small>执行中 / 排队中</small><strong>${count(['queued','uploading','submitting']).toString().padStart(2,'0')}</strong><span>本机串行执行</span></div></div><section class="panel"><div class="panel-head"><h2>任务记录</h2><small>自动更新 · 按任务策略核对与重发</small></div>${data.jobs.length ? data.jobs.map(j => `<div class="task-row"><div><strong>${esc(j.content.versions?.[j.platform]?.title || j.content.title)}</strong><small>${types[j.content.type]} · ${time(j.updated)}</small></div><div>${esc(j.account_name)}<br><small>${names[j.platform]} · ${j.mode === 'demo' ? '演示' : '真实浏览器'}</small></div><div>${badge(j.state)}</div><div><small>${j.receipt ? esc(j.receipt.id || '页面提交标志') : '暂无平台回执'}</small></div><div class="task-actions"><button class="button secondary small" data-job="${j.id}">查看 / 处理</button></div></div>`).join('') : '<div class="empty"><strong>让下一次分发，从这里开始</strong><p>创建内容、选择账号，就会生成各平台的独立任务。</p><a class="button secondary" href="#compose">去创作 →</a></div>'}</section>`;
}
function renderAccounts() {
  const statuses={connected:'已登录，可发布',pending:'待扫码连接',detecting:'等待扫码 / 识别登录',duplicate:'账号重复',needs_login:'需登录 / 核验',identity_mismatch:'身份不一致',disconnected:'已停用'};
  const accounts=data.accounts.filter(a=>accountPlatforms.includes(a.platform)&&(!accountPlatform||a.platform===accountPlatform));
  const filters=['',...accountPlatforms].map(p=>'<button class="account-platform-button '+(accountPlatform===p?'selected':'')+'" data-account-platform="'+p+'" aria-pressed="'+(accountPlatform===p)+'">'+(p?names[p]:'全部平台')+' <span>'+data.accounts.filter(a=>accountPlatforms.includes(a.platform)&&(!p||a.platform===p)).length+'</span></button>').join('');
  const cards=accounts.map(a=>'<section class="panel account-card" data-account-card="'+a.id+'"><div class="account-top">'+icon(a.platform)+'<span class="badge">'+(a.mode==='demo'?'演示账号':esc(statuses[a.status]||a.status))+'</span></div><h3>'+esc(a.name)+'</h3><p>'+names[a.platform]+' · '+(a.mode==='demo'?'仅模拟':('平台身份：'+esc(a.platform_id||'尚未核验')))+'</p><div class="task-actions">'+(a.mode==='demo'?'':[['open','登录 / 打开后台'],['disconnect','停用连接']].map(([action,label])=>'<button class="button secondary small" data-account-action="'+action+'" data-id="'+a.id+'">'+label+'</button>').join(''))+'<button class="button secondary small danger" data-delete-account="'+a.id+'" '+(data.capabilities?.accountDeletion?'':'disabled title="请先重启后台服务"')+'>删除账号</button></div></section>').join('');
  return heading('YOUR CHANNELS, ONE WORKSPACE','连接你的创作阵地','按平台管理账号，每个账号拥有独立的本机登录环境。')+notice()+
    '<section id="account-browser"><div class="account-platforms" role="group" aria-label="账号平台筛选">'+filters+'</div><p class="subtle" role="status">'+(accountPlatform?names[accountPlatform]:'全部平台')+' · '+accounts.length+' 个账号</p><div class="account-grid">'+(cards||'<div class="empty account-empty"><strong>当前平台暂无账号</strong><p>在下方选择平台并添加账号，即可登录接入。</p></div>')+'</div></section>'+
    '<section class="panel account-add-panel"><div class="panel-head"><h2>接入真实账号</h2><small>添加后打开平台后台，扫码完成连接</small></div><form id="account-form" class="panel-body account-form"><label><span class="label">平台</span><select name="platform">'+accountPlatforms.map(p=>'<option value="'+p+'" '+((accountPlatform||'zhihu')===p?'selected':'')+'>'+names[p]+'</option>').join('')+'</select></label><label><span class="label">账号备注</span><input name="name" type="text" maxlength="80" placeholder="例如：我的 B站主账号" required></label><button class="button" type="submit" '+(addingAccount?'disabled':'')+'>添加账号</button></form></section>';
}
function assetCard(a, chooser = false) {
  return '<div class="asset-card" data-asset-id="'+a.id+'"><div class="asset-cover">'+(a.mime.startsWith('image/') ? '<img src="/media/'+a.id+'" alt="'+esc(a.name)+'" loading="lazy">' : '<video src="/media/'+a.id+'" muted preload="metadata" controls></video>')+'</div><div class="asset-info"><strong>'+esc(a.name)+'</strong><small>'+size(a.size)+' · 归档 '+assetDay(a)+'</small><small>上传于 '+time(a.created)+'</small>'+(a.source?'<small>资料配图 · '+esc(a.source.author)+' · '+esc(a.source.license)+'</small><small>来源：'+esc(a.source.pageUrl)+'</small>':'')+'<p class="subtle">'+esc(a.note||'未填写用户备注')+'</p><div class="asset-actions">'+(chooser ? '<button class="button secondary small" data-add-asset="'+a.id+'">'+(form.assetIds.includes(a.id)?'已选择':'添加到内容')+'</button>' : '<button class="button secondary small" data-edit-asset="'+a.id+'">编辑</button><button class="button secondary small danger" data-delete-asset="'+a.id+'">删除</button>')+'</div></div></div>';
}
function assetGroups(assets, chooser = false, order = 'desc') {
  const groups = new Map();
  for (const a of assets) { const day=assetDay(a); if(!groups.has(day))groups.set(day,[]);groups.get(day).push(a); }
  return [...groups.keys()].sort((a,b)=>order==='desc'?b.localeCompare(a):a.localeCompare(b)).map(day=>'<section class="asset-day"><h3>'+day+' <span class="muted">'+groups.get(day).length+' 份素材</span></h3><div class="asset-grid">'+groups.get(day).map(a=>assetCard(a,chooser)).join('')+'</div></section>').join('');
}
function filteredAssets() {
  return data.assets.filter(a=>(!library.date||assetDay(a)===library.date)&&(!library.type||a.mime.startsWith(library.type+'/'))&&(a.name+' '+(a.note||'')).toLocaleLowerCase().includes(library.search.trim().toLocaleLowerCase()));
}
function libraryResults() {
  const assets=filteredAssets();
  return '<p class="subtle" role="status">显示 '+assets.length+' / '+data.assets.length+' 份素材</p>'+(assets.length ? assetGroups(assets,false,library.order) : '<div class="empty"><strong>'+(data.assets.length?'没有符合条件的素材':'给灵感留一个位置')+'</strong><p>'+(data.assets.length?'调整日期、类型或搜索词，或清空筛选。':'上传图片或视频，即可按日期整理并在内容工作室复用。')+'</p></div>');
}
function renderAssets() {
  return heading('A HOME FOR YOUR IDEAS','素材库','按归档日期整理图片与视频，素材仅保存在本机。')+
    '<section class="panel"><div class="panel-body library-upload"><label>上传归档日期<input id="library-upload-date" type="date" value="'+library.uploadDate+'" required></label><label>本批素材备注（可选）<input id="library-upload-note" maxlength="2000" placeholder="内容、主题或使用要求"></label><label class="button" for="library-upload">'+(uploading?'正在保存素材…':'↥ 添加素材')+'</label><input class="hidden" type="file" id="library-upload" accept="image/*,video/*" multiple '+(uploading?'disabled':'')+'><small>支持多选 · 图片或视频 · 单文件不超过 512 MB</small></div></section>'+
    '<section class="panel"><div class="panel-head"><h2>本地素材 <span class="muted">'+data.assets.length+'</span></h2><small>按天归档 · 可编辑名称、日期和备注</small></div><div class="panel-body"><div class="library-filters"><label>搜索名称和备注<input id="library-search" type="search" placeholder="搜索素材名称" value="'+esc(library.search)+'"></label><label>归档日期<input id="library-date" type="date" value="'+library.date+'"></label><label>素材类型<select id="library-type"><option value="">全部类型</option><option value="image" '+(library.type==='image'?'selected':'')+'>图片</option><option value="video" '+(library.type==='video'?'selected':'')+'>视频</option></select></label><label>日期顺序<select id="library-order"><option value="desc" '+(library.order==='desc'?'selected':'')+'>最近日期优先</option><option value="asc" '+(library.order==='asc'?'selected':'')+'>最早日期优先</option></select></label><button class="button secondary small" id="library-clear">清空筛选</button></div><div id="library-results">'+libraryResults()+'</div></div></section>';
}
function bindAssetActions() {
  document.querySelectorAll('[data-edit-asset]').forEach(b=>b.onclick=()=>{
    const a=data.assets.find(a=>a.id===b.dataset.editAsset);
    openDialog('<h2>编辑素材</h2><form id="asset-edit-form"><label class="field"><span class="label">素材名称（保留扩展名）</span><input name="name" value="'+esc(a.name)+'" maxlength="240" required></label><label class="field"><span class="label">归档日期</span><input name="archiveDate" type="date" value="'+assetDay(a)+'" required></label><label class="field"><span class="label">用户备注（供 agent 选材参考）</span><textarea name="note" maxlength="2000" placeholder="内容、适合的主题、使用要求等">'+esc(a.note||'')+'</textarea></label><p id="asset-edit-error" role="alert"></p><button class="button" type="submit">保存修改</button></form>');
    if(a.mime.startsWith('image/')) {
      const button=document.createElement('button');
      button.className='button secondary';button.textContent='识别或校正图片文字';button.type='button';
      $('#asset-edit-form').after(button);
      button.onclick=async()=>{
        try {
          const base='assets/'+a.id;
          let record=await api(base+'/text');
          openDialog('<h2>图片文字</h2><p>'+esc(a.name)+'</p><label class="field">可供选材使用的文字<textarea id="image-text" maxlength="12000"></textarea></label><p class="subtle">勾选使用图片文字的任务可将此内容发给生成模型。</p><button class="button secondary" id="read-image-text">本地识别</button> <button class="button" id="save-image-text">保存校正</button>');
          const field=$('#image-text'),read=$('#read-image-text'),save=$('#save-image-text');
          field.value=record.text;read.disabled=record.version>0;
          read.onclick=async()=>{
            read.disabled=true;save.disabled=true;field.disabled=true;
            try {record=await api(base+'/ocr',{});field.value=record.text;if(!record.text)toast('图片中未识别到文字，可手动填写');}
            catch(e){toast(e.message);read.disabled=false;}
            finally {save.disabled=false;field.disabled=false;}
          };
          save.onclick=async()=>{
            save.disabled=true;
            try {await api(base+'/text',{text:field.value,expectedVersion:record.version});$('#detail').close();toast('图片文字已保存');}
            catch(e){toast(e.message);save.disabled=false;}
          };
        } catch(e){toast(e.message);}
      };
    }
    $('#asset-edit-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('assets/'+a.id,Object.fromEntries(new FormData(e.target)));await refresh();$('#detail').close();render();toast('素材信息已更新');}catch(err){$('#asset-edit-error').textContent=err.message;button.disabled=false;}};
  });
  document.querySelectorAll('[data-delete-asset]').forEach(b=>b.onclick=()=>{
    const a=data.assets.find(a=>a.id===b.dataset.deleteAsset);
    openDialog('<h2>删除素材？</h2><p>将永久删除本机素材文件：<strong>'+esc(a.name)+'</strong></p><p class="subtle">仍被已保存草稿或未结束任务引用的素材，需先解除引用。删除后也会从当前编辑内容的素材选择中移除。</p><p id="asset-delete-error" role="alert"></p><button class="button danger" id="confirm-delete-asset">确认删除</button> <button class="button secondary" id="cancel-delete-asset">取消</button>');
    $('#cancel-delete-asset').onclick=()=>$('#detail').close();
    $('#confirm-delete-asset').onclick=async e=>{e.target.disabled=true;try{await api('assets/'+a.id,undefined,{method:'DELETE',headers:{'X-Studio-Token':data.token}});form.assetIds=form.assetIds.filter(id=>id!==a.id);if(form.coverAssetId===a.id)delete form.coverAssetId;
      const strip = content=>{if(content.bodyHtml){const doc=new DOMParser().parseFromString(content.bodyHtml,'text/html');doc.querySelectorAll('img').forEach(img=>{if(img.getAttribute('src')?.split(/[?#]/)[0]==='/media/'+a.id)img.remove();});content.bodyHtml=doc.body.innerHTML;}Object.values(content.versions||{}).forEach(strip);};strip(form);
      requestKey=crypto.randomUUID();await refresh();$('#detail').close();render();toast('素材已删除');}catch(err){$('#asset-delete-error').textContent=err.message;e.target.disabled=false;}};
  });
}
function renderGuide() {
const readerStates={configured:'已加载本机规则',unconfigured:'未配置',invalid_config:'配置无效，已停用'};
const readers=Object.entries(data.capabilities?.creatorReaders||{}).map(([platform,status])=>
  '<p>'+esc(names[platform])+' · '+esc(readerStates[status]||'未知')+'</p>').join('');
return heading('BROWSER PIPELINE','账号接入与发布流程','独立环境登录 → 核验身份 → 上传填写 → 人工核对 → 提交结果。') + notice() + '<section class="panel"><div class="panel-head"><h2>创作中心查稿配置</h2></div><div class="panel-body">'+readers+'<small>本机配置状态；实际页面需在对应创作者账号中验收。</small></div></section><section class="panel"><div class="panel-body"><p>先在账号管理添加账号，在工具打开的独立浏览器扫码，工具自动识别账号。每次执行前重新检查身份。</p><p>发布规则位于 config/adapters.json，身份读取规则位于 config/identity-selectors.json。当前定位规则是待账号验证的初始配置。</p><p>视频上传、标题和正文自动填写；封面、分区、声明等平台必填项请在官方后台核对。正文图片与封面按对应通道处理，未完成或无法确认时暂停。</p><p>小红书已提供视频 / 图片笔记发布流程；平台页面与账号权限仍需实测。提交结果不明时，按该任务已保存的核对与重发策略处理。</p><p>小红书开放视频和图片笔记；抖音支持视频发布。B站长文章使用新版专栏编辑器，支持正文图片和 AI 辅助创作声明。知乎与小红书支持按所选状态设置创作声明。提交成功标志不代表审核通过或作品已公开。</p></div></section>';
}
function render() {
  editors.forEach(e=>e.destroy());editors=[];
  const views = { macros:()=>macroScreen(data,esc), compose: renderCompose, tasks: renderTasks, accounts: renderAccounts, assets: renderAssets, guide: renderGuide };
  if (!views[page]) page = 'compose';
  $('#breadcrumb').textContent = ({macros:'任务',compose:'内容工作室',tasks:'分发任务',accounts:'账号管理',assets:'素材库',guide:'接入路线'})[page];
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  $('#main').innerHTML = views[page](); updatePreview(); bind();updatePublicationSummary();
  document.querySelectorAll('[data-rich]').forEach(el=>{
    const path=el.dataset.rich;const match=path.match(/^versions\.([^.]+)\.body$/);
    const target=match?(form.versions[match[1]]||={}):form;
    editors.push(mountEditor(el,{html:target.bodyHtml,text:target.body,label:match?names[match[1]]+'正文':'文章正文'},({html,text})=>{target.bodyHtml=html;target.body=text;requestKey=crypto.randomUUID();updatePreview();},{
      onImport:editor=>{
        const input=document.createElement('input');input.type='file';input.accept='.docx';input.onchange=async()=>{
          const file=input.files[0];if(!file)return;
          try{const r=await api('import-word',undefined,{method:'POST',headers:{'X-Studio-Token':data.token,'Content-Type':'application/octet-stream'},body:file});editor.commands.setContent(safeHtml(r.html));toast(r.warnings.length?'已导入，部分Word对象无法转换，请检查格式':'Word已导入，请核对排版');}catch(e){toast(e.message);}
        };input.click();
      },
      onImage:editor=>{
        const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.onchange=async()=>{
          const file=input.files[0];if(!file)return;
          try{const r=await api('assets',undefined,{method:'POST',headers:{'X-Studio-Token':data.token,'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name)},body:file});await refresh();editor.chain().focus().setImage({src:'/media/'+r.id,alt:file.name}).run();}catch(e){toast(e.message);}
        };input.click();
      }
    }));
  });
}
function updateForm(target) {
  const path = target.dataset.field.split('.');
  if (path[0] === 'versions') { form.versions[path[1]] ||= {}; form.versions[path[1]][path[2]] = target.value; }
  else form[path[0]] = target.value;
  requestKey = crypto.randomUUID(); updatePreview();
}
function showIssues(issues) { $('#issues').innerHTML = issues.length ? `<div class="issues"><strong>请先处理以下项目</strong><ul>${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : ''; }
async function uploadFiles(files, toForm) {
  if (uploading || !files.length) return;
  const uploadDate = toForm === false ? library.uploadDate : localDay();
  if (!uploadDate) { toast('请先选择上传归档日期'); return; }
  const uploadNote=toForm===false?($('#library-upload-note')?.value||''):'';
  uploading = true; render();
  try {
    for (const file of files) {
      if (!/^(image|video)\//.test(file.type)) throw new Error('请选择图片或视频文件：'+file.name);
      if (file.size > 512 * 1024 * 1024) throw new Error('单文件不超过512MB（展示版限制）');
      const a = await api('assets', undefined, { method:'POST', headers:{'X-Studio-Token':data.token, 'Content-Type':file.type || 'application/octet-stream', 'X-File-Name':encodeURIComponent(file.name), 'X-Archive-Date':uploadDate}, body:file });
      if(uploadNote)await api('assets/'+a.id,{note:uploadNote});
      if (toForm===true) form.assetIds.push(a.id);else if(toForm==='cover')form.coverAssetId=a.id;
    }
    requestKey = crypto.randomUUID(); await refresh(); toast('素材已保存到本机');
  } catch(e) { toast(e.message); } finally { uploading = false; await refresh(); render(); }
}
function openDialog(html) { modalJob = null; $('#detail-content').innerHTML = html; if (!$('#detail').open) $('#detail').showModal(); }
const recoveryLabels = {missing_visual_model:'agent 未启用图片输入能力',unsupported_visual:'当前账号页不支持视觉恢复',round_limit:'恢复轮数已用尽',observing:'观察原页面',planning:'等待模型',revalidate:'重新执行标准检查',missing_model:'缺少模型配置',
  needs_human:'等待本人处理',identity_mismatch:'账号身份不一致',time_limit:'已到恢复期限',budget_exhausted:'调用次数已用尽',
  cost_limit:'费用预留已到上限',invalid_action:'模型动作无效',recovery_failed:'恢复未完成'};
const checkLabels = {retry_wait:'重发冷却中',retry_ready:'准备最后查重',absent_valid:'已完成有效缺席核对',limit_exhausted:'重发次数已耗尽',outside_window:'重发期限已到',prepared:'等待提交',verifying:'已安排',checking:'进行中',found_published:'后台已发布，公开可见性未核验',
  found_reviewing:'审核中',found_scheduled:'平台已定时',found_draft:'发现草稿',found_rejected:'审核拒绝',
  inconclusive:'证据不足',ambiguous:'候选不唯一',requires_human:'等待本人核对',duplicate_suspected:'疑似重复',
  unsupported_verifier:'此通道尚未接入查稿',stopped:'已停止',observation_timeout:'已到核对截止时间'};
function renderJob(jobId) {
  const j = data.jobs.find(j => j.id === jobId); if (!j) return;
  const v = j.content.versions?.[j.platform] || {};
  $('#detail-content').innerHTML = `<span class="eyebrow">TASK DETAIL · ${j.mode === 'demo' ? '演示任务' : '真实浏览器任务'}</span><h2>${esc(v.title || j.content.title)}</h2>${badge(j.state)}<div class="detail-accounts">目标账号：${esc(j.account_name)} · ${names[j.platform]}<br>任务标识：${j.id}<br>已用提交名额：${j.usedAttempts} / ${1+(j.content.publication?.mode==='auto' && j.mode!=='demo' && j.publicationIntent?.policy.retry.allowAbsentAfterTimeout ? j.publicationIntent.policy.retry.maxResends : 0)}</div>${j.publicationIntent?.policy.verification.enabled ? `<p>创作中心核对：${esc(checkLabels[j.publicationIntent.status] || '等待核对')}${j.publicationIntent.lastObservation ? ' · 上次核对 '+time(j.publicationIntent.lastObservation.checked_at) : ''}${j.publicationIntent.lastObservation?.external_id ? ' · 稿件 '+esc(j.publicationIntent.lastObservation.external_id) : ''}${j.publicationIntent.next_check_at ? ' · 下次核对 '+time(j.publicationIntent.next_check_at)+' <button class="button secondary small" id="stop-check">停止核对</button>' : ''}</p>` : ''}${j.publicationIntent?.recovery ? `<p>模型恢复：${esc(recoveryLabels[j.publicationIntent.recovery.reason] || '等待处理')} · ${j.publicationIntent.recovery.recovery_level==='visual'?'账号页视觉恢复':'结构化恢复'} · 视觉调用 ${j.publicationIntent.recovery.visual_calls||0} · 总调用 ${j.publicationIntent.recovery.calls} / ${j.publicationIntent.recovery.call_limit}</p>` : ''}<p class="subtle">当前任务视觉恢复：${j.publicationIntent?.policy.recovery?.visualEnabled?'已启用':'未启用（沿用创建时保存的策略）'}</p><h3>发布选项</h3>${j.platform==='douyin'?`<p>视频可见范围：${j.content.publication?.douyinVisibility==='private'?'仅自己可见':j.content.publication?.douyinVisibility==='public'?'公开':'沿用平台当前设置'}</p>`:''}<p class="detail-accounts">${j.content.publication?.mode==='auto'?'工具直接完成发布':'发布前人工处理'} · AI辅助创作：${typeof j.content.publication?.aiAssisted==='boolean'?(j.content.publication.aiAssisted?'勾选':'不勾选'):'旧任务未指定'}</p><p class="subtle">${j.content.publication?.mode==='auto' && j.content.publication?.silent!==false?'后台执行；抖音验证时显示原窗口供你完成':'使用可见浏览器执行'}</p>${j.platform==='zhihu'&&j.content.publication?.aiAssisted===false?'<p class="subtle">知乎会尝试取消已有AI声明；无法确认取消时暂停。控件缺失时可不添加声明继续，实际状态以日志及回执为准。</p>':''}${j.state==='needs_verification'?'<p class="subtle">请在原浏览器中完成安全验证。工具只观察发布结果，不会再次点击发布；若平台要求继续操作，请在原页面自行完成。</p>':''}<h3>待提交的平台文案</h3><div class="detail-body">${j.content.type==='article'?safeHtml((v.body?v.bodyHtml:j.content.bodyHtml)||esc(v.body||j.content.body)):esc(v.body||j.content.body||'无正文')}</div><h3>素材</h3><div class="detail-accounts">${j.content.assetIds.map(assetId => esc(data.assets.find(a => a.id === assetId)?.name || '素材缺失')).join('<br>')}</div>${j.platform==='bilibili'&&j.content.coverAssetId?`<p class="subtle">封面：${esc(data.assets.find(a=>a.id===j.content.coverAssetId)?.name||'封面素材缺失')}</p>`:''}<h3>执行日志</h3>${j.events.map(e => `<div class="event"><small>${time(e.created)}</small><span>${esc(e.message)}</span></div>`).join('')}<p class="subtle">${j.receipt ? (j.receipt.simulated ? '模拟回执：'+esc(j.receipt.id || '页面提交标志') : esc(j.receipt.evidence)+(j.receipt.id?' · 稿件ID：'+esc(j.receipt.id):' · 尚无已核验稿件ID')) : '暂无真实平台稿件或作品回执'}</p><div class="task-actions">${j.receipt?.url && /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?$/.test(j.receipt.url)?`<a class="button secondary" href="${esc(j.receipt.url)}" target="_blank" rel="noreferrer">查看知乎稿件</a>`:''}${(['needs_manual','needs_login'].includes(j.state)||(j.state==='awaiting_confirmation'&&j.content.publication?.mode==='auto')) && j.mode!=='demo' && !j.events.some(e=>e.state==='submitting')?`<button class="button" data-action="retry" data-id="${j.id}" title="使用原任务内容和发布选项重新执行">重试未提交任务</button>`:''}${j.platform==='douyin'&&['needs_verification','unknown'].includes(j.state)&&j.events.some(e=>e.state==='submitting')?`<button class="button" data-action="check-result" data-id="${j.id}">我已完成验证，核对结果</button>`:''}${j.mode !== 'demo' ? `<button class="button secondary" data-action="inspect" data-id="${j.id}">${j.state==='needs_verification'?'打开验证页面':'打开任务浏览器'}</button>` : ''}${j.state === 'waiting_human' ? `<button class="button" data-action="human-completed" data-id="${j.id}">本人处理完成，重新核验</button>` : ''}${j.state === 'awaiting_confirmation' ? `<button class="button" data-action="confirm" data-id="${j.id}">${j.mode === 'demo' ? '核对无误，继续演示' : '确认真实提交'}</button>` : ''}${j.state === 'needs_login' && j.mode === 'demo' ? `<button class="button" data-action="resume" data-id="${j.id}">恢复演示会话</button>` : ''}${['unknown','needs_verification','needs_manual','identity_mismatch'].includes(j.state) ? `<button class="button secondary" data-action="resolve" data-id="${j.id}">已人工核对，关闭任务</button>` : ''}${['queued','waiting_human','awaiting_confirmation','needs_login','needs_manual','identity_mismatch'].includes(j.state) ? `<button class="button secondary" data-action="cancel" data-id="${j.id}">取消任务</button>` : ''}</div>`;
  if(j.publicationIntent && j.publicationIntent.status!=='stopped') {
    const actions=$('#detail-content .task-actions');
    const controls=j.usedAttempts>0 && ['unknown','submitted','demo_submitted'].includes(j.state) && j.publicationIntent.status!=='requires_human'
      ? [['verify','主动查稿'],['request-retry','评估重发策略']]
      : !j.usedAttempts && ['needs_manual','needs_login'].includes(j.state) ? [['recover','请求模型恢复']] : [];
    for(const [action,label] of controls) {
      const button=document.createElement('button');button.textContent=label;button.className='button secondary small';
      button.onclick=async()=>{
        button.disabled=true;
        try {const result=await api('publications/'+j.id+'/'+action,{expectedVersion:j.publicationIntent.version});toast(result.reasonCode==='check_throttled'?'已安排核对，请等待下一次检查':'已受理，将按任务策略继续');await refresh();renderJob(jobId);}
        catch(error){toast(error.message);button.disabled=false;}
      };
      actions.append(button);
    }
  }
  if(j.publicationIntent?.lastObservation) {
    const history=document.createElement('button');
    history.className='button secondary small';history.textContent='查看查稿记录';
    $('#detail-content .task-actions').append(history);
    history.onclick=async()=>{
      const entries=[];
      async function show(before) {
        const result=await api('publications/'+j.id+'/observations'+(before?'?before='+before:''));
        entries.push(...result.entries);
        const labels={published:'已发布',reviewing:'审核中',scheduled:'定时',draft:'草稿',rejected:'拒绝'};
        openDialog('<h2>查稿记录</h2>'+entries.map(entry=>{
          const c=entry.coverage;
          return `<section class="event"><small>${time(entry.checked_at)}</small><p>${esc(checkLabels[entry.result]||entry.result)}${entry.external_id?' · 稿件 '+esc(entry.external_id):''}</p>${c?`<p>第 ${entry.ordinal} 次提交 · 核对 ${c.pagesVisited} 页 · ${c.statusesChecked.map(k=>esc(labels[k]||k)).join('、')}<br>覆盖 ${time(c.windowStart)} 至 ${time(c.windowEnd)}</p>`:''}</section>`;
        }).join('')+(result.nextBefore?'<button class="button secondary" id="older-observations">更早记录</button>':''));
        if(result.nextBefore)$('#older-observations').onclick=async e=>{
          e.target.disabled=true;try{await show(result.nextBefore);}catch(err){toast(err.message);e.target.disabled=false;}
        };
      }
      try{await show(null);}catch(err){toast(err.message);}
    };
  }
  if (j.publicationIntent?.status==='requires_human') {
    const actions=$('#detail-content .task-actions');
    for (const [path,label] of [...(data.capabilities?.creatorReaders?.[j.platform]==='configured' && j.mode!=='demo' ? [['open-verifier','打开查稿管理页']] : []),['human-completed','本人处理完成，重新查稿'],['stop','停止核对']]) {
      const button=document.createElement('button');
      button.className='button secondary small';
      button.textContent=label;
      button.onclick=async()=>{
        try {await api(`publications/${j.id}/${path}`,{expectedVersion:j.publicationIntent.version});await refresh();renderJob(jobId);}
        catch(error){toast(error.message);}
      };
      actions.append(button);
    }
  }
  if ($('#stop-check')) $('#stop-check').onclick=async()=>{
    try { await api(`publications/${j.id}/stop`,{expectedVersion:j.publicationIntent.version});await refresh();renderJob(jobId); }
    catch (error) { toast(error.message); }
  };
  $('#detail-content').querySelectorAll('[data-action]').forEach(b => b.onclick = async () => { b.disabled = true; try { const result=await api(`jobs/${b.dataset.id}/${b.dataset.action}`, {confirmReal:b.dataset.action === 'confirm' && j.mode !== 'demo'}); if(result.message)toast(result.message);await refresh(); renderJob(jobId); } catch(e) { toast(e.message); b.disabled = false; } });
}
function bindAccountActions(){
  document.querySelectorAll('[data-account-platform]').forEach(b=>b.onclick=()=>{
    accountPlatform=b.dataset.accountPlatform;
    const temp=document.createElement('div');temp.innerHTML=renderAccounts();
    $('#account-browser').replaceWith(temp.querySelector('#account-browser'));
    const select=$('#account-form [name="platform"]');if(select&&accountPlatform)select.value=accountPlatform;
    bindAccountActions();
  });
  document.querySelectorAll('[data-delete-account]').forEach(b=>b.onclick=()=>{
    const a=data.accounts.find(a=>a.id===b.dataset.deleteAccount);if(!a)return;
    openDialog('<h2>删除账号？</h2><p>确认删除 '+esc(names[a.platform])+' 账号 <strong>'+esc(a.name)+'</strong>？</p><p class="subtle">将关闭账号浏览器并清理该账号在本机的登录环境。历史任务记录保留，重新添加后需再次登录。此操作不会注销平台账号。</p><p class="subtle">有未结束任务时，请先取消任务或核对结果并关闭任务，再删除账号。</p><p id="account-delete-error" role="alert"></p><button class="button danger" id="confirm-delete-account">确认删除账号</button> <button class="button secondary" id="cancel-delete-account">取消</button>');
    $('#cancel-delete-account').onclick=()=>$('#detail').close();
    $('#confirm-delete-account').onclick=async e=>{
      const button=e.currentTarget;button.disabled=true;
      try{const result=await api('accounts/'+a.id,undefined,{method:'DELETE',headers:{'X-Studio-Token':data.token}});selected=selected.filter(id=>id!==a.id);requestKey=crypto.randomUUID();$('#detail').close();await refresh(true);toast(result.message);}
      catch(err){$('#account-delete-error').textContent=err.message;button.disabled=false;}
    };
  });
  document.querySelectorAll('[data-account-action]').forEach(b=>b.onclick=async()=>{
    const label=b.textContent;b.disabled=true;b.textContent='处理中…';
    try { const r=await api('accounts/'+b.dataset.id+'/'+b.dataset.accountAction,{}); toast(r.message); }
    catch(e){toast(e.message);} finally{await refresh(true);}
  });
}
function bind() {
  bindMacros({data,esc,api,refresh,render,toast,openDialog});
  if ($('#recover-prepare')) $('#recover-prepare').onchange=e=>{
    form.publicationPolicy ??= {};
    form.publicationPolicy.recovery={...form.publicationPolicy.recovery,enabled:e.target.checked};
    requestKey=crypto.randomUUID();
  };
  for(const id of ['recover-visual','recover-structured'])if($('#'+id))$('#'+id).onchange=e=>{form.publicationPolicy??={};form.publicationPolicy.recovery={...form.publicationPolicy.recovery,[id==='recover-visual'?'visualEnabled':'structuredCallsBeforeVisual']:id==='recover-visual'?e.target.checked:Number(e.target.value)};requestKey=crypto.randomUUID();};
  if ($('#creator-check')) $('#creator-check').onchange=e=>{
    form.publicationPolicy ??= {};
    form.publicationPolicy.verification={...form.publicationPolicy.verification,enabled:e.target.checked};
    if (!e.target.checked) delete form.publicationPolicy.retry;
    requestKey=crypto.randomUUID();
    render();
  };
  document.querySelectorAll('[data-verification]').forEach(input=>input.oninput=()=>{
    form.publicationPolicy.verification[input.dataset.verification]=input.value===''?null:Number(input.value);
    requestKey=crypto.randomUUID();
  });
  const saveRetry=()=>{
    const maxResends=Number($('#retry-limit').value);
    const delays=$('#retry-delays').value.trim();
    form.publicationPolicy.retry={maxResends,allowAbsentAfterTimeout:maxResends>0,
      cooldownSeconds:delays?delays.split(/[,，]/).map(v=>v.trim()===''?null:Number(v.trim())):[]};
    requestKey=crypto.randomUUID();
  };
  if ($('#retry-limit')) $('#retry-limit').oninput=saveRetry;
  if ($('#retry-delays')) $('#retry-delays').oninput=saveRetry;
  bindAccountActions();
  if($('#publication-douyin-visibility'))$('#publication-douyin-visibility').onchange=e=>{form.publication.douyinVisibility=e.target.value||null;requestKey=crypto.randomUUID();};
  if($('#publication-mode'))$('#publication-mode').onchange=e=>{form.publication.mode=e.target.value;requestKey=crypto.randomUUID();updatePublicationSummary();};
  if($('#publication-silent'))$('#publication-silent').onchange=e=>{form.publication.silent=e.target.checked;requestKey=crypto.randomUUID();};
  if($('#publication-ai'))$('#publication-ai').onchange=e=>{form.publication.aiAssisted=e.target.value===''?null:e.target.value==='yes';requestKey=crypto.randomUUID();updatePublicationSummary();};
  if ($('#scenario')) $('#scenario').onchange = () => { requestKey = crypto.randomUUID(); };
  document.querySelectorAll('[data-field]').forEach(el => el.oninput = () => updateForm(el));
  document.querySelectorAll('[data-type]').forEach(el => el.onclick = () => { form.type = el.dataset.type;if(form.type!=='video')delete form.coverAssetId; selected=selected.filter(id=>{const a=data.accounts.find(a=>a.id===id);return a&&data.platforms[a.platform]?.types.includes(form.type);}); requestKey = crypto.randomUUID(); render(); });
  document.querySelectorAll('[data-preview]').forEach(el => el.onclick = () => { previewPlatform = el.dataset.preview; render(); });
  if ($('#target-platform')) $('#target-platform').onchange=e=>{targetPlatform=e.target.value;render();};
  document.querySelectorAll('[data-account]').forEach(el => el.onchange = () => { selected = selected.filter(id=>id!==el.dataset.account);if(el.checked)selected.push(el.dataset.account); requestKey = crypto.randomUUID(); $('#selection-count').textContent = `已选择 ${selected.length} 个账号`; updatePublicationSummary(); });
  document.querySelectorAll('[data-remove-asset]').forEach(el => el.onclick = () => { form.assetIds = form.assetIds.filter(a => a !== el.dataset.removeAsset); requestKey = crypto.randomUUID(); render(); });
  if($('#cover-upload'))$('#cover-upload').onchange=e=>uploadFiles([...e.target.files],'cover');
  if ($('#upload')) $('#upload').onchange = e => uploadFiles([...e.target.files], true);
  if ($('#library-upload-date')) $('#library-upload-date').onchange=e=>library.uploadDate=e.target.value;
  const updateLibrary=()=>{$('#library-results').innerHTML=libraryResults();bindAssetActions();};
  for (const key of ['date','type','order','search']) if ($('#library-'+key)) $('#library-'+key).oninput=e=>{library[key]=e.target.value;updateLibrary();};
  if ($('#library-clear')) $('#library-clear').onclick=()=>{Object.assign(library,{date:'',type:'',search:'',order:'desc'});render();};
  bindAssetActions();
  if ($('#library-upload')) $('#library-upload').onchange = e => uploadFiles([...e.target.files], false);
  if ($('.upload')) { $('.upload').ondragover = e => e.preventDefault(); $('.upload').ondrop = e => { e.preventDefault(); uploadFiles([...e.dataTransfer.files], true); }; }
  if ($('#choose-assets')) $('#choose-assets').onclick = () => { openDialog('<h2>选择本地素材</h2>'+assetGroups(data.assets,true)); document.querySelectorAll('[data-add-asset]').forEach(b => b.onclick = () => { if (!form.assetIds.includes(b.dataset.addAsset)) form.assetIds.push(b.dataset.addAsset); requestKey = crypto.randomUUID(); $('#detail').close(); render(); }); };
  if ($('#validate')) $('#validate').onclick = async () => { try { const r = await api('validate', { content:form, accountIds:selected }); showIssues(r.issues); if (!r.issues.length) toast('演示校验通过；平台具体规则仍需真实联调'); } catch(e) { toast(e.message); } };
  if ($('#dispatch')) $('#dispatch').onclick = async () => {
    if (submitting) return; submitting = true; $('#dispatch').disabled = true;
    const scenario = $('#scenario').value;
    try { const r = await api('dispatch', { content:form, accountIds:selected, requestKey, scenario, publicationPolicy:form.publicationPolicy }); toast(r.reused ? '该次分发已创建，已返回既有任务' : form.publication?.mode==='auto'?'已按所选方式创建直接发布任务':'已创建任务，发布前等待人工处理'); page = 'tasks'; location.hash = 'tasks'; await refresh(true); }
    catch(e) { showIssues(e.issues || [e.message]); } finally { submitting = false; if ($('#dispatch')) $('#dispatch').disabled = uploading; }
  };
  if ($('#save-draft')) $('#save-draft').onclick = async () => { try { const r = await api('drafts', { content:form, id:draftId }); draftId = r.id; await refresh(); toast('草稿已保存在本机'); render(); } catch(e) { toast(e.message); } };
  if ($('#open-drafts')) $('#open-drafts').onclick = () => { openDialog('<h2>本地草稿</h2><div class="draft-list">'+(data.drafts.length ? data.drafts.map(d => `<div class="draft-row"><span>${esc(d.title || '未命名草稿')}<small class="muted"> · ${time(d.updated)}</small></span><button class="button secondary small" data-draft="${d.id}">继续编辑</button></div>`).join('') : '<p class="subtle">还没有已保存的草稿。</p>')+'</div>'); document.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => { const d = data.drafts.find(d => d.id === b.dataset.draft); const { id, updated, ...content } = d; form = structuredClone(content); draftId = id; requestKey = crypto.randomUUID(); $('#detail').close(); render(); }); };
  if ($('#account-form')) $('#account-form').onsubmit = async e => {
    e.preventDefault();if(addingAccount)return;
    const values=Object.fromEntries(new FormData(e.target));addingAccount=true;e.target.querySelector('button').disabled=true;
    let created=false;
    try{
      const result=await api('accounts',values);created=true;accountPlatform=values.platform;
      await refresh(true);toast('账号记录已添加，正在打开平台登录后台…');
      await api('accounts/'+result.id+'/open',{});
      toast('平台后台已打开，请扫码登录；识别到真实账号后会显示“已登录，可发布”。');
    }catch(err){toast(created?'账号记录已添加，但登录后台未能打开：'+err.message+'。请点击“登录 / 打开后台”重试。':err.message);}
    finally{addingAccount=false;await refresh(true);}
  };
  document.querySelectorAll('[data-job]').forEach(b => b.onclick = () => { modalJob = b.dataset.job; renderJob(modalJob); $('#detail').showModal(); });
}
$('.close-dialog').onclick = () => $('#detail').close();
$('#detail').addEventListener('close', () => { modalJob = null; });
addEventListener('hashchange', () => { page = location.hash.slice(1) || 'compose'; render(); window.scrollTo(0,0); });
await refresh(true);
setInterval(() => refresh(), 1800);
