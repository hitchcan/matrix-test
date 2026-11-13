// Input observations come from the verifier, never from a request body.
// All timestamps in this evaluator are epoch milliseconds.
export function evaluateAbsentRetry({ policy, invokedAt, deadlineAt, now, ordinal, observations, stopped }) {
  const { retry, verification } = policy;
  if (stopped) return { reasonCode: 'stopped' };
  if (retry.allowAbsentAfterTimeout !== true || verification.enabled !== true) return { reasonCode: 'retry_disabled' };
  const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
  if (!nonnegative(retry.maxResends) || !Array.isArray(retry.cooldownSeconds) ||
      retry.cooldownSeconds.length < retry.maxResends || !retry.cooldownSeconds.every(nonnegative) ||
      ![verification.checkIntervalSeconds, verification.requiredValidChecks, verification.absenceWindowSeconds,
        verification.lastCheckFreshnessSeconds].every(n => nonnegative(n) && n > 0)) {
    return { reasonCode: 'invalid_policy' };
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > retry.maxResends) return { reasonCode: 'limit_exhausted' };
  if (![now, invokedAt, deadlineAt].every(Number.isSafeInteger) || now >= deadlineAt || invokedAt > now) return { reasonCode: 'outside_window' };
  const checks = observations.filter(o => o.checkedAt >= invokedAt && o.checkedAt <= now)
    .sort((a,b) => a.checkedAt - b.checkedAt);
  if (checks.some(o => o.result.startsWith('found_') || o.result === 'duplicate_suspected')) {
    return { reasonCode: 'candidate_found' };
  }
  const valid = o => o?.result === 'absent_valid' && o.coverage?.complete === true &&
    o.accountIdentity?.verified === true && !!o.accountIdentity.expected &&
    o.accountIdentity.expected === o.accountIdentity.observed && o.ordinal === ordinal;
  let lastCounted = -Infinity;
  let qualifiedAt;
  let count = 0;
  for (const check of checks) {
    if (!valid(check) || check.checkedAt - lastCounted < verification.checkIntervalSeconds * 1000) continue;
    lastCounted = check.checkedAt;
    if (++count === verification.requiredValidChecks) qualifiedAt = lastCounted;
  }
  if (qualifiedAt === undefined) return { reasonCode: 'insufficient_checks' };
  const eligibleAt = Math.max(qualifiedAt, invokedAt + verification.absenceWindowSeconds * 1000)
    + retry.cooldownSeconds[ordinal - 1] * 1000;
  if (eligibleAt >= deadlineAt) return { reasonCode: 'outside_window' };
  if (now < eligibleAt) return { reasonCode: 'cooldown', eligibleAt };
  const final = checks.at(-1);
  if (!valid(final) || final.allAttemptsCovered !== true || final.checkedAt < eligibleAt ||
      now - final.checkedAt > verification.lastCheckFreshnessSeconds * 1000) return { reasonCode: 'final_check_required' };
  return { reasonCode: 'eligible' };
}
