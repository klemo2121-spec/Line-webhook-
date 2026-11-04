const digest = value => /^[a-f0-9]{64}$/.test(value || '');
const imageName = value => typeof value === 'string' && value.length <= 240 && !/[\\/\x00-\x1f]/.test(value) && /\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif)$/i.test(value);

// The authenticated local worker inventories the actual document attachments.
// It verifies the downloaded ZIP byte-for-byte before it can acknowledge LINE.
export function validateArchiveEvidence(archive, job) {
  const { manifest, filename, sha256, bytes, limitObserved, limitReason, limitMessage, inventory } = archive || {};
  const { plan:p, evidence:e } = job;
  if (!p || !e || limitObserved !== true || !digest(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 10 * 1024 * 1024) throw Error('ZIP fallback needs a verified document, observed limit and valid archive');
  if (!['image_count_limit','attachment_count_limit'].includes(limitReason) || typeof limitMessage !== 'string' || !limitMessage.trim() || limitMessage.length > 500) throw Error('ZIP is only allowed after an explicit image/attachment count limit, not a transient upload error');
  if (filename !== `line-${p.month}-${p.bucket}-${sha256.slice(0,12)}.zip`) throw Error('ZIP filename does not match archive digest');
  const scope = manifest?.scope;
  if (manifest?.version !== 1 || scope?.companyId !== e.companyId || scope.month !== p.month || scope.bucket !== p.bucket || String(scope.recordId) !== String(e.recordId) || scope.serial !== e.serial) throw Error('ZIP belongs to a different monthly document');
  if (!Array.isArray(inventory) || inventory.length > 1000 || inventory.some(n=>!imageName(n)) || new Set(inventory).size !== inventory.length) throw Error('Invalid image inventory');
  const entries = manifest.entries;
  if (!Array.isArray(entries) || !entries.length || entries.length !== inventory.length + 1 || entries.length > 1001) throw Error('ZIP does not cover all document images plus the new original');
  const paths = new Set(), existing = new Set(); let current = 0, totalBytes = 0;
  for (const item of entries) {
    if (!imageName(item.sourceName) || !/^images\/[0-9]{4}-[a-f0-9]{12}\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif)$/i.test(item.name || '') || paths.has(item.name) || !digest(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw Error('Invalid ZIP image member');
    paths.add(item.name); totalBytes += item.bytes;
    if (item.source === 'current') {
      current++;
      if (item.sourceName !== job.filename || item.sha256 !== job.imageHash) throw Error('ZIP is missing the exact original LINE image');
    } else if (item.source === 'existing' && inventory.includes(item.sourceName) && !existing.has(item.sourceName)) existing.add(item.sourceName);
    else throw Error('ZIP image is outside the document inventory');
  }
  if (current !== 1 || existing.size !== inventory.length || totalBytes > 100 * 1024 * 1024) throw Error('Incomplete or oversized ZIP image set');
  return archive;
}
