// Immutable per-dataset snapshot. `freeze-snapshot` derives source IDs, main-chunker records and gold exactly once;
// every run, anchor seal and evaluation loads this file (bound by an externally recorded SHA-256) and verifies
// the dataset against it instead of recomputing identities.
import { readFile } from 'node:fs/promises';
import { canonicalChunks, canonicalGold, canonicalQuestions, canonicalSources } from './canonical.mjs';
import { SOURCE_ID_DERIVATION, sha256, sourceIdFor } from './dataset.mjs';

export const SNAPSHOT_FORMAT = 'prism-issue-99-snapshot/v1';

function resolveGold(questions, sources, chunks) {
  return questions.map((question) => {
    const source = sources.find((record) => record.path === question.path);
    const chunk = chunks.find((item) => item.source_id === source.source_id &&
      item.location.startLine <= question.goldLine && question.goldLine <= item.location.endLine);
    if (!chunk) throw new Error(`Gold line of ${question.id} is not inside a chunk.`);
    return { id: question.id, path: question.path, goldLine: question.goldLine, resolution: question.resolution,
      sourceId: source.source_id, chunkId: chunk.chunk_id, startLine: chunk.location.startLine, endLine: chunk.location.endLine };
  });
}

function chunksFor(sources, contents, chunkMarkdown) {
  const chunks = sources.flatMap((record) => chunkMarkdown(record.source_id, contents.get(record.path)));
  if (new Set(chunks.map((chunk) => chunk.chunk_id)).size !== chunks.length) throw new Error('Chunk IDs collide across sources.');
  return chunks;
}

function digests(snapshot) {
  return {
    sourcesSha256: sha256(canonicalSources(snapshot.sources)),
    chunksSha256: sha256(canonicalChunks(snapshot.chunks)),
    questionsSha256: sha256(canonicalQuestions(snapshot.questions)),
    goldSha256: sha256(canonicalGold(snapshot.gold)),
    updateScenariosSha256: sha256(JSON.stringify(snapshot.updateScenarios)),
  };
}

/** One-time freeze. The caller must record the written file's SHA-256 outside this harness. */
export function buildSnapshot(datasetName, dataset, chunkMarkdown) {
  const contents = new Map(dataset.notes.map((note) => [note.path, note.content]));
  const sources = dataset.notes.map((note) => ({ source_id: sourceIdFor(note.path), path: note.path,
    content_hash: sha256(note.content), mtime: 1, size: Buffer.byteLength(note.content) }));
  if (new Set(sources.map((record) => record.source_id)).size !== sources.length) throw new Error('Source ID derivation collided.');
  const chunks = chunksFor(sources, contents, chunkMarkdown);
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    datasetName,
    inputs: {
      files: Object.entries(dataset.digests.files).map(([file, hash]) => ({ path: file, sha256: hash })),
      combinedLoaderSha256: dataset.digests.combinedLoaderSha256,
      questionsJsonSha256: dataset.digests.questionsJsonSha256,
      fixtureManifestSha256: dataset.digests.fixtureManifestSha256,
      notes: dataset.notes.map((note) => ({ path: note.path, normalizedSha256: sha256(note.content) })),
    },
    sourceIdDerivation: SOURCE_ID_DERIVATION,
    sources,
    chunks,
    questions: dataset.questions.map((question) => ({ id: question.id, group: question.group, question: question.question,
      path: question.path })),
    gold: resolveGold(dataset.questions, sources, chunks),
    updateScenarios: dataset.updates,
  };
  return { ...snapshot, digests: digests(snapshot) };
}

export async function readSnapshot(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('An externally recorded snapshot SHA-256 is required.');
  const bytes = await readFile(file);
  const sha = sha256(bytes);
  if (sha !== expectedSha256) throw new Error('Snapshot file does not match its recorded SHA-256; evidence is blocked.');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  if (snapshot.format !== SNAPSHOT_FORMAT || JSON.stringify(digests(snapshot)) !== JSON.stringify(snapshot.digests)) {
    throw new Error('Snapshot content does not match its recorded digests; evidence is blocked.');
  }
  return { ...snapshot, sha256: sha };
}

/** Digests every run, anchor seal and gate report must carry. */
export function snapshotBinding(snapshot) {
  return { snapshotSha256: snapshot.sha256, datasetName: snapshot.datasetName,
    combinedLoaderSha256: snapshot.inputs.combinedLoaderSha256, fixtureManifestSha256: snapshot.inputs.fixtureManifestSha256,
    ...snapshot.digests };
}

/**
 * Verifies a freshly loaded dataset against the frozen snapshot and returns the run inputs. Source records come from
 * the snapshot; chunks and gold are recomputed only to prove they still equal the frozen values.
 */
export function bindDataset(snapshot, dataset, chunkMarkdown) {
  const mismatch = (what) => { throw new Error(`Dataset ${what} differs from the frozen snapshot; evidence is blocked.`); };
  const files = Object.entries(dataset.digests.files).map(([file, hash]) => ({ path: file, sha256: hash }));
  if (JSON.stringify(files) !== JSON.stringify(snapshot.inputs.files)) mismatch('file hashes');
  if (dataset.digests.combinedLoaderSha256 !== snapshot.inputs.combinedLoaderSha256) mismatch('combined loader hash');
  if (dataset.digests.fixtureManifestSha256 !== snapshot.inputs.fixtureManifestSha256) mismatch('fixture manifest');
  const notes = dataset.notes.map((note) => ({ path: note.path, normalizedSha256: sha256(note.content) }));
  if (JSON.stringify(notes) !== JSON.stringify(snapshot.inputs.notes)) mismatch('normalized notes');
  if (snapshot.sources.some((record, index) => record.path !== dataset.notes[index]?.path ||
      record.content_hash !== sha256(dataset.notes[index].content)) || snapshot.sources.length !== dataset.notes.length) {
    mismatch('source records');
  }
  const contents = new Map(dataset.notes.map((note) => [note.path, note.content]));
  if (canonicalChunks(chunksFor(snapshot.sources, contents, chunkMarkdown)) !== canonicalChunks(snapshot.chunks)) mismatch('chunk records');
  const questions = dataset.questions.map((question) => ({ id: question.id, group: question.group, question: question.question, path: question.path }));
  if (canonicalQuestions(questions) !== canonicalQuestions(snapshot.questions)) mismatch('questions');
  if (canonicalGold(resolveGold(dataset.questions, snapshot.sources, snapshot.chunks)) !== canonicalGold(snapshot.gold)) mismatch('gold');
  if (JSON.stringify(dataset.updates) !== JSON.stringify(snapshot.updateScenarios)) mismatch('update scenarios');
  return {
    notes: dataset.notes,
    questions: snapshot.questions.map((question, index) => ({ ...question, gold: snapshot.gold[index] })),
    sourceRecords: snapshot.sources,
    snapshotChunks: snapshot.chunks,
    updates: snapshot.updateScenarios,
    binding: snapshotBinding(snapshot),
  };
}
