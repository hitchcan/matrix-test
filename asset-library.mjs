// Archive days are calendar dates, independent of upload timestamps.
export function archiveDay(timestamp = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}
export function validArchiveDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01' &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function referencesAsset(content, assetId) {
  if (!content || typeof content !== 'object') return false;
  if (content.assetIds?.includes(assetId) || content.coverAssetId === assetId) return true;
  if (typeof content.bodyHtml === 'string' && new RegExp(`/media/${assetId}(?=["'\\s<>?#]|$)`).test(content.bodyHtml)) return true;
  return Object.values(content.versions || {}).some(v => referencesAsset(v, assetId));
}
