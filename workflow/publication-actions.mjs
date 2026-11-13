import {attemptsFor,retryDecision} from './retry-evidence.mjs';
const fault=(reasonCode,message,status=409)=>Object.assign(Error(message),{reasonCode,status});
export function publicationActions({db,clock,getIntent,getJob,event,hasVerifier,hasModel,canRecover,interrupt}) {
  return function act(id,action,body={}) {
    if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>k!=='expectedVersion'))
      throw fault('invalid_input','动作只接受 expectedVersion',422);
    db.exec('BEGIN IMMEDIATE');
    try {
      const intent=getIntent(id);
      if(!intent)throw fault('not_found','发布任务不存在',404);
      if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion!==intent.version)throw fault('version_conflict','任务版本已更新，请重新读取');
      const job=getJob(id),attempts=attemptsFor(db,id),now=clock();
      const done=(reasonCode)=>{const publication=getIntent(id);db.exec('COMMIT');return {ok:true,reasonCode,publication};};
      const change=(status,due)=>db.prepare('UPDATE publication_intents SET status=?,next_check_at=?,version=version+1 WHERE job_id=? AND version=?').run(status,due,id,intent.version);
      if(action==='stop') {
        change('stopped',null);
        if(!attempts.length && !['cancelled','manually_closed'].includes(job.state))event(id,'cancelled','用户停止了提交前任务。');
        const result=done('stopped');interrupt(id);return result;
      }
      if(intent.status==='stopped')throw fault('stopped','任务已停止');
      if(['recovering','uploading','submitting','opening_settings'].includes(job.state)||['checking','retry_ready'].includes(intent.status))
        throw fault('owner_busy','当前操作持有任务控制权');
      if(action==='recover' && !attempts.length) {
        if(!['needs_manual','needs_login'].includes(job.state))throw fault('invalid_stage','该阶段不能请求恢复');
        if(!intent.policy.recovery?.enabled)throw fault('recovery_disabled','任务未启用模型恢复');
        if(!hasModel())throw fault('missing_model','未配置恢复模型');
        if(!canRecover())throw fault('unsupported_recovery','运行时未实现恢复观察');
        event(id,'queued','已请求按原任务快照重新检查并恢复准备。');
        change('prepared',null);return done('recovery_scheduled');
      }
      if(action==='human-completed' && !attempts.length) {
        if(job.state!=='waiting_human')throw fault('invalid_stage','当前没有待完成的本人处理');
        event(id,'queued','本人处理完成，将重新观察账号和稿件。');
        change('prepared',null);return done('observation_scheduled');
      }
      if(!attempts.length)throw fault('not_submitted','尚无提交尝试');
      if(!['unknown','submitted','demo_submitted'].includes(job.state))throw fault('needs_human','请先处理原页面验证或人工接管');
      if(intent.status==='requires_human' && action!=='human-completed')throw fault('needs_human','请先完成本人处理');
      if(!hasVerifier(job.platform))throw fault('unsupported_verifier','该平台未配置核对器');
      const deadline=intent.deadline_at || new Date(Date.parse(attempts[0].invoked_at)+intent.policy.verification.maxObserveDurationSeconds*1000).toISOString();
      if(now>=deadline)throw fault('observation_timeout','已超过核对期限');
      if(!intent.deadline_at)db.prepare('UPDATE publication_intents SET deadline_at=? WHERE job_id=?').run(deadline,id);
      if(action==='request-retry') {
        const decision=retryDecision(db,{job_id:id,policy_snapshot:JSON.stringify(intent.policy),deadline_at:deadline,status:intent.status},Date.parse(now));
        // This action evaluates stored evidence. Only the monitor performs the final check.
        if(['retry_disabled','limit_exhausted','outside_window','candidate_found','invalid_policy'].includes(decision.reasonCode))
          throw fault(decision.reasonCode,'当前策略或证据不允许重发');
      }
      const last=db.prepare('SELECT checked_at FROM verification_observations WHERE job_id=? ORDER BY id DESC LIMIT 1').get(id);
      const due=action==='human-completed'?now:new Date(Math.max(Date.parse(now),last?Date.parse(last.checked_at)+intent.policy.verification.checkIntervalSeconds*1000:0)).toISOString();
      if(intent.next_check_at && intent.next_check_at>now && due>=intent.next_check_at && action!=='human-completed')return done('check_throttled');
      change('verifying',due);
      return done(action==='request-retry'?'retry_evaluation_scheduled':action==='recover'?'verification_before_recovery':'verification_scheduled');
    } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  };
}
