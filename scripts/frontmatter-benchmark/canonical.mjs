// Canonical serializations shared by the Node CLI and the Electron renderer, so both sides compute identical
// digests for the frozen snapshot. Field order is fixed explicitly; never rely on object key order.

export async function sha256Text(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalSources(records) {
  return JSON.stringify(records.map((record) => ({ source_id: record.source_id, path: record.path,
    content_hash: record.content_hash, mtime: record.mtime, size: record.size })));
}

export function canonicalChunks(chunks) {
  return JSON.stringify(chunks.map((chunk) => ({ chunk_id: chunk.chunk_id, source_id: chunk.source_id, content: chunk.content,
    content_hash: chunk.content_hash, location: { startLine: chunk.location.startLine, endLine: chunk.location.endLine } })));
}

export function canonicalQuestions(questions) {
  return JSON.stringify(questions.map((question) => ({ id: question.id, group: question.group, question: question.question,
    path: question.path })));
}

export function canonicalGold(gold) {
  return JSON.stringify(gold.map((item) => ({ id: item.id, path: item.path, goldLine: item.goldLine, resolution: item.resolution,
    sourceId: item.sourceId, chunkId: item.chunkId, startLine: item.startLine, endLine: item.endLine })));
}
