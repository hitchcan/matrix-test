import { absenceEvidence, attemptsFor, retryDecision } from './retry-evidence.mjs';
const results = new Set(['found_published','found_reviewing','found_scheduled','found_draft','found_rejected',
  'absent_valid','ambiguous','inconclusive','requires_human','duplicate_suspected']);
const terminal = new Set(['found_published','found_draft','found_rejected','requires_human','duplicate_suspected','unsupported_verifier']);

export function publicationMonitor({ db, clock, verifier, runtime, resend, isClosed }) {
  let busy = false;
  return async function tick() {
    if (busy || isClosed()) return;
    const now = new Date(clock()).toISOString();
    const row = db.prepare(`SELECT i.*,j.account_id,j.platform,d.snapshot,a.platform_id
      FROM publication_intents i JOIN jobs j ON j.id=i.job_id JOIN dispatches d ON d.id=j.dispatch_id
      JOIN accounts a ON a.id=j.account_id
      WHERE i.next_check_at<=? AND j.state IN ('unknown','submitted','demo_submitted')
      ORDER BY i.next_check_at,i.job_id LIMIT 1`).get(now);
    if (!row) return;
    const update = db.prepare('UPDATE publication_intents SET status=?,next_check_at=?,version=version+1 WHERE job_id=? AND version=?');
    if (now >= row.deadline_at) {
      update.run('observation_timeout',null,row.job_id,row.version);
      return;
    }
    busy = true;
    try {
      // A crashed process leaves a bounded read-only lease. A newer owner invalidates this result.
      const leaseEnd = new Date(Date.parse(now)+60000).toISOString();
      if (!update.run('checking',leaseEnd,row.job_id,row.version).changes) return;
      let result = 'unsupported_verifier';
      let externalId = null;
      let evidence = null;
      const attempts = attemptsFor(db,row.job_id);
      if (verifier) {
        try {
          const observed = await verifier({jobId:row.job_id,accountId:row.account_id,
            version:row.version+1,platform:row.platform,expectedIdentity:row.platform_id,content:JSON.parse(row.snapshot),
            attempts,runtime,checkStartedAt:Date.parse(now)});
          result = results.has(observed?.result) ? observed.result : 'inconclusive';
          if (result !== 'requires_human' && (!row.platform_id || observed?.accountIdentity?.verified !== true ||
              observed.accountIdentity.observed !== row.platform_id)) result = 'inconclusive';
          // Only independent, account-bound coverage can contribute to absence checks.
          if (observed?.result === 'unsupported_verifier') result = 'unsupported_verifier';
          if (result.startsWith('found_') && typeof observed.externalId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(observed.externalId)) externalId=observed.externalId;
          if (result === 'absent_valid') {
            evidence = absenceEvidence(observed,attempts,row.platform_id,Date.parse(clock()),Date.parse(now));
            if (!evidence) result = 'inconclusive';
          }
        } catch { result = 'inconclusive'; }
      }
      if (isClosed()) return;
      const checkedAt = new Date(clock()).toISOString();
      const interval = JSON.parse(row.policy_snapshot).verification.checkIntervalSeconds;
      const continueDuplicateWatch = attempts.length > 1 && result === 'found_published';
      const next = (!JSON.parse(row.policy_snapshot).verification.enabled || (terminal.has(result) && !continueDuplicateWatch)) ? null : new Date(Math.min(Date.parse(row.deadline_at), Date.parse(checkedAt)+interval*1000)).toISOString();
      let readyVersion;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (update.run(result,next,row.job_id,row.version+1).changes) {
          db.prepare('INSERT INTO verification_observations(job_id,checked_at,result,external_id,evidence) VALUES(?,?,?,?,?)').run(row.job_id,checkedAt,result,externalId,evidence && JSON.stringify(evidence));
          if (result==='absent_valid') {
            const decision = retryDecision(db,row,Date.parse(checkedAt));
            const version = row.version+2;
            if (decision.reasonCode==='eligible' && resend) {
              update.run('retry_ready',next,row.job_id,version);
              readyVersion=version+1;
            } else if (decision.reasonCode==='cooldown') {
              update.run('retry_wait',new Date(decision.eligibleAt).toISOString(),row.job_id,version);
            } else if (decision.reasonCode==='limit_exhausted' || decision.reasonCode==='outside_window') {
              update.run(decision.reasonCode,attempts.length>1 ? next : null,row.job_id,version);
            }
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (readyVersion !== undefined && !isClosed()) await resend(row,readyVersion);
    } finally { busy = false; }
  };
}
