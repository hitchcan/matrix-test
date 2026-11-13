const defaults = {
  recovery: { enabled:true, visualEnabled:false, structuredCallsBeforeVisual:2, maxRoundsPerIncident:2, maxActionsPerIncident:12, maxIncidentDurationSeconds:180 },
  verification: { enabled:false, firstCheckAfterSeconds:180, checkIntervalSeconds:300,
    absenceWindowSeconds:1800, requiredValidChecks:3, lastCheckFreshnessSeconds:30, maxObserveDurationSeconds:86400 },
  retry: { maxResends:0, allowAbsentAfterTimeout:false, cooldownSeconds:[], retryDeadlineSeconds:21600 }
};

function invalid(field) {
  throw Object.assign(new Error('发布策略参数无效：' + field), {status:422, reasonCode:'invalid_policy'});
}

export function publicationPolicy(input = {}) {
  function object(value, allowed, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !Object.hasOwn(allowed,key))) invalid(field);
  }
  object(input, defaults, 'publicationPolicy');
  const result = structuredClone(defaults);
  for (const section of Object.keys(defaults)) {
    if (!Object.hasOwn(input,section)) continue;
    object(input[section], defaults[section], section);
    for (const [key,value] of Object.entries(input[section])) {
      const base = defaults[section][key];
      if (Array.isArray(base)) {
        if (!Array.isArray(value) || value.length > 100 || value.some(n => !Number.isSafeInteger(n) || n < 0 || n > 31536000)) invalid(key);
      } else if (typeof base === 'boolean') {
        if (typeof value !== 'boolean') invalid(key);
      } else if (!Number.isSafeInteger(value) || value < (['maxResends','firstCheckAfterSeconds'].includes(key) ? 0 : 1) || value > 31536000) invalid(key);
      result[section][key] = structuredClone(value);
    }
  }
  const {retry, verification:v} = result;
  if(result.recovery.structuredCallsBeforeVisual>32)invalid('structuredCallsBeforeVisual');
  if (retry.cooldownSeconds.length < retry.maxResends) invalid('cooldownSeconds');
  if (v.enabled && v.firstCheckAfterSeconds >= v.maxObserveDurationSeconds) invalid('firstCheckAfterSeconds');
  if (retry.allowAbsentAfterTimeout && retry.maxResends > 0) {
    const earliest = Math.max(v.absenceWindowSeconds,v.firstCheckAfterSeconds + (v.requiredValidChecks-1)*v.checkIntervalSeconds);
    if (!v.enabled || earliest + retry.cooldownSeconds[0] >= Math.min(retry.retryDeadlineSeconds,v.maxObserveDurationSeconds)) invalid('retryDeadlineSeconds');
  }
  return result;
}
