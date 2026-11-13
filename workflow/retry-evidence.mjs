import { evaluateAbsentRetry } from './retry-policy.mjs';

export const requiredViews = ['published','reviewing','scheduled','draft','rejected'];

export function attemptsFor(db,id) {
  return db.prepare('SELECT ordinal,invoked_at FROM publication_attempts WHERE job_id=? ORDER BY ordinal').all(id);
}

export function absenceEvidence(observed, attempts, expectedIdentity, checkedAt, started) {
  const c = observed.coverage;
  if (!expectedIdentity || observed.accountIdentity?.observed !== expectedIdentity ||
      observed.accountIdentity?.verified !== true || !attempts.length || c?.complete !== true ||
      !Number.isSafeInteger(c.pagesVisited) || c.pagesVisited < 1 ||
      !Array.isArray(c.statusesChecked) || !requiredViews.every(v=>c.statusesChecked.includes(v)) ||
      !Number.isFinite(c.windowStart) || c.windowStart > Date.parse(attempts[0].invoked_at) ||
      !Number.isFinite(c.windowEnd) || c.windowEnd < Date.parse(attempts.at(-1).invoked_at) ||
      c.windowEnd < started || c.windowEnd > checkedAt || !Array.isArray(observed.candidates) || observed.candidates.length) return null;
  return {coverage:{complete:true,pagesVisited:c.pagesVisited,statusesChecked:requiredViews,
    windowStart:c.windowStart,windowEnd:c.windowEnd},allAttemptsCovered:true,
    ordinal:attempts.at(-1).ordinal,accountIdentity:{expected:expectedIdentity,observed:expectedIdentity,verified:true}};
}

export function retryDecision(db,intent,at) {
  const attempts = attemptsFor(db,intent.job_id);
  const policy = JSON.parse(intent.policy_snapshot);
  const observations = db.prepare('SELECT checked_at,result,evidence FROM verification_observations WHERE job_id=? ORDER BY id').all(intent.job_id)
    .map(row=>({...JSON.parse(row.evidence || '{}'),result:row.result,checkedAt:Date.parse(row.checked_at)}));
  const latest = attempts.at(-1);
  return evaluateAbsentRetry({policy,observations,now:at,ordinal:latest.ordinal,invokedAt:Date.parse(latest.invoked_at),
    deadlineAt:Math.min(Date.parse(intent.deadline_at),Date.parse(attempts[0].invoked_at)+policy.retry.retryDeadlineSeconds*1000),
    stopped:intent.status==='stopped'});
}
