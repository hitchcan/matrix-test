const fail=message=>Object.assign(Error(message),{status:422});
const DAY=86400000,OFFSET=8*3600000;
export const chinaParts=value=>new Date(Date.parse(value)+OFFSET).toISOString().slice(0,16);
export function normalizeSchedule(s={}) {
  s??={};
  if(typeof s!=='object'||Array.isArray(s))throw fail('定时设置无效');
  const kind=s.kind|| (s.intervalSeconds?'interval':s.startAt?'once':'manual');
  if(!['manual','once','interval','daily','weekly','monthly'].includes(kind))throw fail('定时频率无效');
  const start=s.startAt==null?null:Date.parse(s.startAt),end=s.endAt==null?null:Date.parse(s.endAt);
  if(start!==null&&(!Number.isFinite(start)||!/(Z|[+-]\d\d:\d\d)$/.test(s.startAt)))throw fail('开始时间需含时区');
  if(kind!=='manual'&&start===null)throw fail('请选择开始日期和时间');
  if(end!==null&&(!Number.isFinite(end)||end<start))throw fail('结束时间不能早于开始时间');
  const interval=s.intervalSeconds??0,lead=s.prepareLeadSeconds??0;
  if(!Number.isSafeInteger(interval)||interval<0||interval>31536000||(kind==='interval'&&interval<60))throw fail('周期间隔至少一分钟');
  if(!Number.isSafeInteger(lead)||lead<0||lead>604800||(kind==='interval'&&lead>=interval))throw fail('提前生成时间无效');
  const times=s.times??(start===null?[]:[chinaParts(new Date(start).toISOString()).slice(11)]);
  if(!Array.isArray(times)||times.length>24||(['daily','weekly','monthly'].includes(kind)&&!times.length)||times.some(t=>typeof t!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw fail('请选择有效发布时段，最多24个');
  const weekdays=s.weekdays??[1,2,3,4,5,6,0],monthDays=s.monthDays??[1];
  if(!Array.isArray(weekdays)||!weekdays.length||weekdays.some(v=>!Number.isInteger(v)||v<0||v>6))throw fail('请选择星期');
  if(!Array.isArray(monthDays)||!monthDays.length||monthDays.some(v=>!Number.isInteger(v)||v<1||v>31))throw fail('请选择每月日期');
  if(!['latest','skip'].includes(s.latePolicy??'latest'))throw fail('错过周期策略无效');
  return {timezone:'Asia/Shanghai',kind,startAt:kind==='manual'?null:new Date(start).toISOString(),endAt:end===null?null:new Date(end).toISOString(),intervalSeconds:kind==='interval'?interval:0,prepareLeadSeconds:lead,latePolicy:s.latePolicy??'latest',times:[...new Set(times)].sort(),weekdays:[...new Set(weekdays)],monthDays:[...new Set(monthDays)]};
}
// Inclusive search. Calendar calculations use fixed China standard time, independent of host timezone.
export function occurrence(s,from,backward=false) {
  const start=Date.parse(s.startAt);if(!Number.isFinite(start))return null;
  const end=s.endAt?Date.parse(s.endAt):Infinity;
  const kind=s.kind||(s.intervalSeconds?'interval':'once');
  let at=backward?Math.min(from,end):Math.max(from,start);
  if(at<start||at>end)return null;
  if(kind==='manual')return null;
  if(kind==='once')return (backward?start<=at:start>=at)&&start<=end?start:null;
  if(kind==='interval'){
    const n=(backward?Math.floor:Math.ceil)((at-start)/(s.intervalSeconds*1000));
    const value=start+n*s.intervalSeconds*1000;return value>=start&&value<=end?value:null;
  }
  const base=Math.floor((at+OFFSET)/DAY)*DAY-OFFSET;
  const times=[...(s.times||[])].sort();if(backward)times.reverse();
  for(let i=0;i<370;i++){
    const day=base+(backward?-i:i)*DAY,date=new Date(day+OFFSET);
    if(kind==='weekly'&&!s.weekdays.includes(date.getUTCDay()))continue;
    if(kind==='monthly'&&!s.monthDays.includes(date.getUTCDate()))continue;
    for(const time of times){const [h,m]=time.split(':').map(Number),value=day+(h*60+m)*60000;
      if(value>=start&&value<=end&&(backward?value<=at:value>=at))return value;}
  }
  return null;
}
