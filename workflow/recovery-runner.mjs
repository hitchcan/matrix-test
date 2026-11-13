import {validVisualAction} from './coordinate-recovery.mjs';
// Calls are charged before contacting the provider, including failed/aborted requests.
export function recoveryRunner({db,model,runtime,lockBrowser,event,isClosed,clock,limits}) {
  const limitsOk = (n,max)=>Number.isSafeInteger(n) && n>0 && n<=max;
  const {maxCalls=4,maxSeconds=180,maxMicros=null,callMicros=0}=limits;
  if (maxMicros!==null && (!Number.isSafeInteger(maxMicros) || maxMicros<0 || !limitsOk(callMicros,1_000_000_000))) throw Error('模型费用预算参数无效');
  if (!limitsOk(maxCalls,32) || !limitsOk(maxSeconds,3600)) throw Error('恢复预算参数无效');
  const pending=new Map();
  function interrupt(id) {pending.get(id)?.abort();}
  async function run(job,account,editor,policy,session) {
    const controller=new AbortController();
    pending.set(job.id,controller);
    const observe=session?.observe ?? (()=>runtime.observeRecovery(account,editor));
    const observeVisual=session?.observeVisual??(session?.stage!=='verification'&&typeof runtime.observeVisualRecovery==='function'?()=>runtime.observeVisualRecovery(account,editor):null);
    const reveal=session?.reveal ?? (()=>runtime.reveal?.(account));
    const report=session?.report ?? ((state,message)=>event(job.id,state,message));
    const owns=session?.active ?? (()=>db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state==='recovering');
    const current=()=>!isClosed() && !controller.signal.aborted &&
      owns();
    const start=Date.parse(clock());
    db.prepare('INSERT OR IGNORE INTO recovery_incidents(job_id,deadline,call_limit,max_micros,call_micros) VALUES(?,?,?,?,?)')
      .run(job.id,start+Math.min(maxSeconds,policy.maxIncidentDurationSeconds)*1000,Math.min(maxCalls,policy.maxActionsPerIncident),maxMicros,maxMicros===null?0:callMicros);
    if (session) {
      db.prepare("UPDATE recovery_incidents SET stage=?,rounds=0,deadline=? WHERE job_id=? AND stage<>?")
        .run(session.stage,start+Math.min(maxSeconds,policy.maxIncidentDurationSeconds)*1000,job.id,session.stage);
    }
    const incident=db.prepare('SELECT * FROM recovery_incidents WHERE job_id=?').get(job.id);
    const remaining=Math.max(1,incident.deadline-start);
    const timeout=AbortSignal.timeout(remaining);
    const signal=AbortSignal.any([controller.signal,timeout]);
    let lastAction=null;
    function stop(reason,message,state='needs_manual') {
      if (!current()) return;
      db.prepare('UPDATE recovery_incidents SET reason=? WHERE job_id=?').run(reason,job.id);
      report(state,message);
    }
    try {
      if (!db.prepare('UPDATE recovery_incidents SET rounds=rounds+1 WHERE job_id=? AND rounds<?').run(job.id,policy.maxRoundsPerIncident+(policy.visualEnabled?incident.call_limit:0)).changes) {
        stop('round_limit','标准准备复核仍未通过，已达恢复轮数上限。');return;
      }
      while(current()) {
        if (signal.aborted || Date.parse(clock())>=incident.deadline) {stop('time_limit','恢复时间已用尽，请接管页面。');return;}
        const ledger=db.prepare('SELECT * FROM recovery_incidents WHERE job_id=?').get(job.id);
        if(ledger.calls>=ledger.call_limit){stop('budget_exhausted','恢复请求次数已用尽，请接管页面。');return;}
        const visual=policy.visualEnabled&&(ledger.recovery_level==='visual'||ledger.calls>=Math.min(policy.structuredCallsBeforeVisual,Math.max(0,ledger.call_limit-2))||ledger.rounds>policy.maxRoundsPerIncident);
        if(visual&&(!observeVisual||model?.visionAvailable!==true)){stop(!observeVisual?'unsupported_visual':'missing_visual_model','视觉恢复需要当前账号页能力及已启用图片输入的 agent 模型。');return;}
        let release=await lockBrowser();
        let snapshot;
        try {
          if (!current()) return;
          if(visual) {
            const identity=await runtime.check(account,true);
            if(!current())return;
            if(identity.platformId!==account.platform_id){stop('identity_mismatch','账号身份不一致，未截取页面。');return;}
          }
          snapshot=await (visual?observeVisual():observe());
          if (!current()) {await snapshot.dispose?.();return;}
          if (snapshot.human) {
            stop('needs_human','当前页面需要本人检查，请在账号浏览器中处理。','waiting_human');
            await reveal();
            return;
          }
        } finally {release();}
        try {
          if (!current()) return;
          if (!model || model.available===false) {stop('missing_model','未配置恢复模型，请接管或配置模型后重试。');return;}
          const usage=db.prepare('SELECT reserved_micros,max_micros,call_micros FROM recovery_incidents WHERE job_id=?').get(job.id);
          if (usage.max_micros!==null && usage.reserved_micros+usage.call_micros>usage.max_micros) {
            stop('cost_limit','恢复调用的预留费用已达预算，请接管页面。');return;
          }
          if (!db.prepare("UPDATE recovery_incidents SET calls=calls+1,visual_calls=visual_calls+?,recovery_level=?,reserved_micros=reserved_micros+call_micros,reason='planning' WHERE job_id=? AND calls<call_limit AND deadline>? AND (max_micros IS NULL OR reserved_micros+call_micros<=max_micros)")
              .run(visual?1:0,visual?'visual':'structured',job.id,Date.parse(clock())).changes) {stop('budget_exhausted','恢复预算已用尽，请接管页面。');return;}
          if(visual&&ledger.recovery_level!=='visual')report('recovering','结构化恢复未完成，已升级为当前账号标签页内的脱敏视觉恢复。');
          signal.throwIfAborted();
          let rejectWait;
          const aborted=new Promise((_,reject)=>{rejectWait=()=>reject(Error('aborted'));});
          signal.addEventListener('abort',rejectWait,{once:true});
          let action;
          try {action=await Promise.race([model(lastAction?{...snapshot.observation,lastAction}:snapshot.observation,{signal}),aborted]);}
          finally {signal.removeEventListener('abort',rejectWait);}
          if (!current()) return;
          if (signal.aborted || Date.parse(clock())>=incident.deadline) {stop('time_limit','恢复时间已用尽，请接管页面。');return;}
          if (action && typeof action.token==='string' && action.token!==snapshot.observation.token) continue;
          if (visual?!validVisualAction(action,snapshot.observation):!action||Object.keys(action).length!==2||typeof action.action!=='string'||action.token!==snapshot.observation.token||!snapshot.observation.actions.includes(action.action)) {stop('invalid_action','模型返回的动作或页面标识无效，已暂停。');return;}
          release=await lockBrowser();
          try {
            if (!current() || signal.aborted) {stop('time_limit','恢复已超时，请接管页面。');return;}
            if (action.action==='human') {stop('needs_human','恢复模型请求本人接管。','waiting_human');await reveal();return;}
            const identity=await runtime.check(account,true);
            if (!current()) return;
            if (identity.platformId!==account.platform_id) {stop('identity_mismatch','账号身份不一致，已停止恢复。');return;}
            if (signal.aborted) {stop('time_limit','恢复已超时，请接管页面。');return;}
            const performed=await snapshot.perform(visual?action:action.action);
            if(visual&&action.action==='click_at'){
              lastAction={action:'click_at',x:action.x,y:action.y,goal:action.goal,outcome:performed?'clicked_reobserve_required':'blocked_reobserve_required'};
              report('recovering',`视觉目标 ${action.goal}：坐标 (${action.x}, ${action.y}) ${performed?'已点击':'未通过控件校验，未点击'}，将重新观察。`);
            }
            if(!performed)continue;
            if (!current()) return;
            if (['revalidate','retry_image_upload'].includes(action.action)) {
              db.prepare("UPDATE recovery_incidents SET reason='revalidate' WHERE job_id=?").run(job.id);
              report('queued',session?.stage==='verification'?'已请求重新读取管理页。':'恢复模型已请求重新执行标准准备与提交前复核。');
              return true;
            }
            report('recovering',action.action==='restore_title'?'已按任务快照恢复空标题，重新观察页面。':visual?'已执行受控视觉动作，重新观察当前账号页。':'已关闭操作提示，重新观察原页面。');
          } finally {release();}
        } finally {await snapshot.dispose?.();}
      }
    } catch {stop(timeout.aborted?'time_limit':'recovery_failed','恢复未完成，请接管账号页面。');}
    finally {if(pending.get(job.id)===controller)pending.delete(job.id);}
  }
  return {run,interrupt,close(){for(const controller of pending.values())controller.abort();}};
}
