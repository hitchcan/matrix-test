import {randomInt} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

const cancelled=()=>Object.assign(Error('操作已停止，取消节奏等待'),{code:'operation_cancelled'});
// Delays only separate workflow stages. They do not substitute for readiness,
// identity/content checks, retry cooldowns or the persistent submission gate.
export function operationPacer({enabled=true,minMs=500,maxMs=1400,random=randomInt}={}) {
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(minMs)||!Number.isSafeInteger(maxMs)||minMs<0||maxMs<minMs||maxMs>10000)throw Error('操作节奏参数无效：延迟须在 0–10000 毫秒之间，最大值不得小于最小值');
  const controller=new AbortController();
  async function wait(page,kind,{isActive=()=>true}={}) {
    const active=()=>!controller.signal.aborted&&!page.isClosed()&&isActive();
    if(!active())throw cancelled();
    if(!enabled)return 0;
    const factor=['submit','upload'].includes(kind)?2:1;
    const duration=minMs===maxMs?minMs*factor:random(minMs*factor,maxMs*factor+1);
    const end=performance.now()+duration;
    while(performance.now()<end) {
      if(!active())throw cancelled();
      try {await sleep(Math.max(1,Math.min(100,end-performance.now())),undefined,{signal:controller.signal});}catch {throw cancelled();}
    }
    if(!active())throw cancelled();return duration;
  }
  return {enabled,minMs,maxMs,wait,close:()=>controller.abort()};
}
