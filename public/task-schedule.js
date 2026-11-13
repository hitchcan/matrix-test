const options=(values,current,label=v=>v)=>values.map(v=>`<option value="${v}" ${String(v)===String(current)?'selected':''}>${label(v)}</option>`).join('');
const parts=iso=>iso?new Date(Date.parse(iso)+28800000).toISOString().slice(0,16):'';
const pad=n=>String(n).padStart(2,'0');
export function timeChoice(prefix,value='09:00') {
  const [h,m]=value.split(':');
  return `<div class="task-clock"><select name="${prefix}Hour" aria-label="小时">${options(Array.from({length:24},(_,i)=>pad(i)),h)}</select><span>时</span><select name="${prefix}Minute" aria-label="分钟">${options(Array.from({length:60},(_,i)=>pad(i)),m)}</select><span>分</span></div>`;
}
export function scheduleForm(s={},esc) {
  const start=parts(s.startAt),end=parts(s.endAt),kind=s.kind||(s.intervalSeconds?'interval':s.startAt?'once':'manual');
  const interval=s.intervalSeconds||3600,unit=interval%86400===0?86400:interval%3600===0?3600:60;
  const amount=interval/unit;
  return `<p class="subtle task-wide">所有时间均为北京时间（UTC+8）。提前生成后等待到点分发；平台审核和浏览器执行耗时可能影响最终上线时间。</p>
  <label class="field">发布频率<select name="scheduleKind">${options(['manual','once','interval','daily','weekly','monthly'],kind,v=>({manual:'仅手动运行',once:'指定时间，单次发布',interval:'按固定间隔',daily:'每天，多个时段',weekly:'每周，指定星期',monthly:'每月，指定日期'})[v])}</select></label>
  <div data-schedule="timed" class="field"><label for="task-start-date">开始日期</label><input type="date" id="task-start-date" name="startDate" value="${esc(start.slice(0,10))}">${timeChoice('start',start.slice(11)||'09:00')}</div>
  <div data-schedule="timed" class="field"><label>结束日期（可选）<input type="date" name="endDate" value="${esc(end.slice(0,10))}"></label>${timeChoice('end',end.slice(11)||'23:59')}</div>
  <div data-schedule="interval" class="field"><span>每隔</span><div class="task-clock"><select name="intervalAmount">${options([...new Set([...Array.from({length:60},(_,i)=>i+1),amount])].sort((a,b)=>a-b),amount)}</select><select name="intervalUnit">${options([60,3600,86400],unit,v=>({60:'分钟',3600:'小时',86400:'天'})[v])}</select></div></div>
  <div data-schedule="calendar" class="field task-wide"><span>每日发布时段</span><div id="task-time-slots">${(s.times?.length?s.times:[start.slice(11)||'09:00']).map(t=>`<div class="task-time-slot">${timeChoice('slot',t)}<button type="button" class="button secondary small" data-remove-slot>移除</button></div>`).join('')}</div><button type="button" class="button secondary small" id="task-add-slot">添加时段</button></div>
  <fieldset data-schedule="weekly" class="task-days task-wide"><legend>每周发布日</legend>${['日','一','二','三','四','五','六'].map((v,i)=>`<label><input type="checkbox" name="weekdays" value="${i}" ${(s.weekdays||[1,2,3,4,5]).includes(i)?'checked':''}>周${v}</label>`).join('')}</fieldset>
  <fieldset data-schedule="monthly" class="task-days task-wide"><legend>每月发布日（不存在的日期自动跳过）</legend>${Array.from({length:31},(_,i)=>`<label><input type="checkbox" name="monthDays" value="${i+1}" ${(s.monthDays||[1]).includes(i+1)?'checked':''}>${i+1}日</label>`).join('')}</fieldset>
  <label data-schedule="timed" class="field">提前生成<select name="lead">${options([...new Set([0,60,300,600,900,1800,3600,7200,21600,43200,86400,172800,604800,s.prepareLeadSeconds??0])].sort((a,b)=>a-b),s.prepareLeadSeconds??0,v=>v===0?'到点再处理':v<3600?`${v/60} 分钟前`:v<86400?`${v/3600} 小时前`:`${v/86400} 天前`)}</select></label>
  <label data-schedule="timed" class="field">错过周期<select name="late">${options(['latest','skip'],s.latePolicy||'latest',v=>v==='latest'?'只执行最近一期，避免集中补发':'迟到超过一分钟则跳过')}</select></label>`;
}
export function bindSchedule(form) {
  const sync=()=>form.querySelectorAll('[data-schedule]').forEach(n=>{
    const kind=form.elements.scheduleKind.value,group=n.dataset.schedule;
    n.hidden=!(group==='timed'?kind!=='manual':group==='calendar'?['daily','weekly','monthly'].includes(kind):group===kind);
    n.querySelectorAll('input,select,button').forEach(e=>e.disabled=n.hidden);
  });
  const bindRemove=()=>form.querySelectorAll('[data-remove-slot]').forEach(b=>b.onclick=()=>{b.closest('.task-time-slot').remove();});
  form.elements.scheduleKind.onchange=sync;
  form.querySelector('#task-add-slot').onclick=()=>{
    if(form.querySelectorAll('.task-time-slot').length>=24)return;
    form.querySelector('#task-time-slots').insertAdjacentHTML('beforeend',`<div class="task-time-slot">${timeChoice('slot')}<button type="button" class="button secondary small" data-remove-slot>移除</button></div>`);bindRemove();
  };
  bindRemove();sync();
}
export function readSchedule(form) {
  const f=new FormData(form),kind=f.get('scheduleKind');
  const at=prefix=>f.get(prefix+'Date')?new Date(`${f.get(prefix+'Date')}T${f.get(prefix+'Hour')}:${f.get(prefix+'Minute')}:00+08:00`).toISOString():null;
  return {timezone:'Asia/Shanghai',kind,startAt:kind==='manual'?null:at('start'),endAt:kind==='manual'?null:at('end'),intervalSeconds:kind==='interval'?Number(f.get('intervalAmount'))*Number(f.get('intervalUnit')):0,prepareLeadSeconds:Number(f.get('lead')||0),latePolicy:f.get('late')||'latest',times:kind==='daily'||kind==='weekly'||kind==='monthly'?[...form.querySelectorAll('.task-time-slot')].map(n=>n.querySelector('[name=slotHour]').value+':'+n.querySelector('[name=slotMinute]').value):undefined,weekdays:kind==='weekly'?f.getAll('weekdays').map(Number):undefined,monthDays:kind==='monthly'?f.getAll('monthDays').map(Number):undefined};
}
export const chinaTime=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'';
