import { attemptsFor, retryDecision } from './workflow/retry-evidence.mjs';
import { publicationPolicy } from './workflow/publication-policy.mjs';
/** Charge the final action before invocation, under the same write lock as its event. */
export function submissionService(db, event, clock) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) {
      db.exec(`CREATE TABLE IF NOT EXISTS publication_attempts(
    job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    invoked_at TEXT NOT NULL, PRIMARY KEY(job_id, ordinal));
    INSERT OR IGNORE INTO publication_attempts
      SELECT job_id, 1, MIN(created) FROM events WHERE state='submitting' GROUP BY job_id;
    INSERT OR IGNORE INTO publication_attempts
      SELECT id, 1, updated FROM jobs WHERE state IN ('submitting','submitted','demo_submitted','needs_verification');`);

      db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) {
      db.exec(`CREATE TABLE publication_intents(job_id TEXT PRIMARY KEY, policy_snapshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared', version INTEGER NOT NULL DEFAULT 0,
        next_check_at TEXT, deadline_at TEXT);
        CREATE INDEX publication_checks_due ON publication_intents(next_check_at);
        CREATE TABLE verification_observations(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL,
          checked_at TEXT NOT NULL, result TEXT NOT NULL);`);
      db.prepare(`INSERT INTO publication_intents(job_id,policy_snapshot,status)
        SELECT id,?,CASE WHEN EXISTS(SELECT 1 FROM publication_attempts WHERE job_id=jobs.id)
        THEN 'unmonitored' ELSE 'prepared' END FROM jobs`).run(JSON.stringify(publicationPolicy()));
      db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) {
      db.exec('CREATE TABLE verification_baselines(job_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL)');
      db.exec('ALTER TABLE verification_observations ADD COLUMN external_id TEXT');
      db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=4').get()) {
      db.exec('ALTER TABLE verification_observations ADD COLUMN evidence TEXT');
      db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()) {
      db.exec(`CREATE TABLE attempt_receipts(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
        receipt TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
        INSERT INTO attempt_receipts
          SELECT j.id,MAX(a.ordinal),j.receipt FROM jobs j JOIN publication_attempts a ON j.id=a.job_id
          WHERE j.receipt IS NOT NULL GROUP BY j.id;
        CREATE TRIGGER record_attempt_receipt AFTER UPDATE OF receipt ON jobs WHEN NEW.receipt IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO attempt_receipts SELECT job_id,ordinal,NEW.receipt FROM publication_attempts
          WHERE job_id=NEW.id ORDER BY ordinal DESC LIMIT 1;
        END;`);
      db.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=6').get()) {
      db.exec(`CREATE TABLE recovery_incidents(job_id TEXT PRIMARY KEY,deadline INTEGER NOT NULL,
        call_limit INTEGER NOT NULL,calls INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT 'observing')`);
      db.prepare('INSERT INTO schema_migrations VALUES(6,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=7').get()) {
      db.exec(`ALTER TABLE recovery_incidents ADD COLUMN reserved_micros INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recovery_incidents ADD COLUMN max_micros INTEGER;
        ALTER TABLE recovery_incidents ADD COLUMN call_micros INTEGER NOT NULL DEFAULT 0`);
      db.prepare('INSERT INTO schema_migrations VALUES(7,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=8').get()) {
      db.exec('ALTER TABLE recovery_incidents ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0');
      db.prepare('INSERT INTO schema_migrations VALUES(8,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=9').get()) {
      db.exec("ALTER TABLE recovery_incidents ADD COLUMN stage TEXT NOT NULL DEFAULT 'prepare'");
      db.prepare('INSERT INTO schema_migrations VALUES(9,?)').run(clock());
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=15').get()) {
      db.exec(`ALTER TABLE recovery_incidents ADD COLUMN visual_calls INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recovery_incidents ADD COLUMN recovery_level TEXT NOT NULL DEFAULT 'structured'`);
      db.prepare('INSERT INTO schema_migrations VALUES(15,?)').run(clock());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return function beginSubmission(jobId, message, retryVersion) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const job = db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId);
      const intent = db.prepare('SELECT * FROM publication_intents WHERE job_id=?').get(jobId);
      const retrying = retryVersion !== undefined;
      const states = retrying ? ['unknown','submitted'] : ['uploading','awaiting_confirmation'];
      if (!states.includes(job?.state)) {
        throw Object.assign(new Error('任务状态不允许提交'), { status: 409 });
      }
      if (intent?.status === 'stopped') {
        throw Object.assign(new Error('任务已停止'), {status:409,state:'cancelled'});
      }
      const at = clock();
      let ordinal = 1;
      if (retrying) {
        if (intent.version !== retryVersion || intent.status !== 'retry_ready' ||
            retryDecision(db,intent,Date.parse(at)).reasonCode !== 'eligible') throw Error('retry_not_authorized');
        ordinal = attemptsFor(db,jobId).at(-1).ordinal+1;
      }
      const result = db.prepare('INSERT OR IGNORE INTO publication_attempts VALUES(?,?,?)')
        .run(jobId, ordinal, at);
      if (!result.changes) throw Object.assign(new Error('该任务已使用首次提交名额'), { status: 409, state: 'unknown' });

      const { verification } = JSON.parse(intent.policy_snapshot);
      const invoked = Date.parse(at);
      const due = seconds => verification.enabled ? new Date(invoked + seconds * 1000).toISOString() : null;
      db.prepare('UPDATE publication_intents SET status=?,version=version+1,next_check_at=?,deadline_at=COALESCE(deadline_at,?) WHERE job_id=?')
        .run(verification.enabled ? 'verifying' : 'unmonitored',due(verification.firstCheckAfterSeconds),due(verification.maxObserveDurationSeconds),jobId);
      if (retrying) db.prepare('UPDATE jobs SET receipt=NULL WHERE id=?').run(jobId);
      event(jobId, 'submitting', message);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
}
