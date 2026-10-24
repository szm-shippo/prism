// Loads a benchmark dataset root (`corpus/**.md`, `questions.json`, required `manifest.json`), verifies its
// hashes and adapts the original (#96) and held-out update-scenario schemas to one form. No question is
// treated specially: gold is located mechanically from `goldLine` or the `section` line text.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { frontmatterRange, readAttributes } from './search-input.mjs';

const LINE_BREAK = /\r\n|\n|\r/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validRelativePath(relative) {
  return !relative.startsWith('/') &&
    !relative.split('/').some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part));
}

async function markdownFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Dataset entries must not be links: ${relative}`);
    if (entry.isDirectory()) files.push(...await markdownFiles(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
  }
  return files;
}

/** The #96 harness loader digest: notes as `path\0content\0` in sorted order, then questions and scenarios. */
export function combinedLoaderHash(notes, questions, updateScenarios) {
  const hash = createHash('sha256');
  for (const note of notes) hash.update(`${note.path}\0${note.content}\0`);
  hash.update(JSON.stringify({ questions, updateScenarios }));
  return hash.digest('hex');
}

export const SOURCE_ID_DOMAIN = 'prism-issue-99-source';
export const SOURCE_ID_DERIVATION = { domain: SOURCE_ID_DOMAIN, version: 1,
  method: 'UUID-shaped first 32 hex of SHA-256(domain + "\\0" + canonical relative path), computed once at snapshot freeze' };

/** Deterministic UUID-shaped source ID. Used only once by freeze-snapshot; runs load the frozen records. */
export function sourceIdFor(notePath) {
  const hex = sha256(`${SOURCE_ID_DOMAIN}\0${notePath}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function goldLineOf(question, content) {
  const lines = content.split(LINE_BREAK);
  const sectionLine = typeof question.section === 'string'
    ? lines.findIndex((line) => line.trimEnd() === question.section) + 1 || null : null;
  if (question.goldLine !== undefined) {
    if (Number.isSafeInteger(question.goldLine) && question.goldLine >= 1 && question.goldLine <= lines.length) {
      return { goldLine: question.goldLine, resolution: 'goldLine', sectionLine };
    }
    if (typeof question.goldLine === 'string') {
      const index = lines.findIndex((line) => line.trimEnd() === question.goldLine.trimEnd());
      if (index >= 0) return { goldLine: index + 1, resolution: 'goldLine-text', sectionLine };
    }
    throw new Error(`Question ${question.id} has a goldLine outside its note.`);
  }
  if (sectionLine) return { goldLine: sectionLine, resolution: 'section', sectionLine };
  throw new Error(`Question ${question.id} has no gold line or matching section line.`);
}

function editMap(name, value, notes, contents) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must map note paths to edits.`);
  for (const notePath of notes) {
    const edit = value[notePath];
    if (!Array.isArray(edit) || edit.length !== 2 || edit.some((item) => typeof item !== 'string') || edit[0] === edit[1]) {
      throw new Error(`${name} needs an [oldLiteral, newLiteral] pair for ${notePath}.`);
    }
    if (!contents.get(notePath).includes(edit[0])) throw new Error(`${name} literal is absent from ${notePath}.`);
  }
  return Object.fromEntries(notes.map((notePath) => [notePath, [...value[notePath]]]));
}

/** Converts both scenario schemas to { notes, edits: { nonTargetFrontmatter, indexedAttribute, body } }. */
export function adaptUpdateScenarios(scenarios, contents) {
  const notes = scenarios?.notes;
  if (!Array.isArray(notes) || notes.length === 0 || new Set(notes).size !== notes.length ||
      notes.some((notePath) => !contents.has(notePath))) {
    throw new Error('updateScenarios.notes must list distinct corpus notes.');
  }
  let nonTarget = scenarios.excludedEdits;
  let attribute = scenarios.attributeEdits;
  if (nonTarget === undefined && attribute === undefined) {
    // Original schema: the #96 harness inserted lines before the first "\n---\n" and a tag after "tags: [".
    if (!Array.isArray(scenarios.excludedLines) || typeof scenarios.addedTag !== 'string') {
      throw new Error('updateScenarios needs excludedEdits/attributeEdits or excludedLines/addedTag.');
    }
    const lines = scenarios.excludedLines.join('\n');
    nonTarget = Object.fromEntries(notes.map((notePath) => [notePath, ['\n---\n', `\n${lines}\n---\n`]]));
    attribute = Object.fromEntries(notes.map((notePath) => [notePath, ['tags: [', `tags: [${scenarios.addedTag}, `]]));
  }
  return {
    notes: [...notes],
    edits: {
      nonTargetFrontmatter: editMap('excludedEdits', nonTarget, notes, contents),
      indexedAttribute: editMap('attributeEdits', attribute, notes, contents),
      body: editMap('bodyEdits', scenarios.bodyEdits, notes, contents),
    },
  };
}

export const UPDATE_NOTE_COUNT = 4;
// Same ATX heading and fence rules as src/core/index/markdown-chunker.ts; setext underlines do not split chunks there.
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether the main chunker treats physical line `target` of `lines` as an ATX heading (outside fenced code). */
function chunkerHeading(lines, target) {
  let fence;
  for (let index = 0; index < target; index += 1) {
    const match = FENCE.exec(lines[index]);
    if (!match) continue;
    const marker = match[1][0];
    if (!fence) fence = { marker, length: match[1].length };
    else if (fence.marker === marker && match[1].length >= fence.length) fence = undefined;
  }
  return !fence && !FENCE.test(lines[target]) && HEADING.test(lines[target]);
}

/** Physical lines with their start offsets, split exactly as the main chunker splits them. */
function physicalLines(content) {
  const lines = [];
  let start = 0;
  for (const match of content.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ start, text: content.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  lines.push({ start, text: content.slice(start) });
  return lines;
}

/** Character offset just past the closing frontmatter delimiter line (including its line break), or 0. */
function frontmatterEnd(content) {
  const range = frontmatterRange(content);
  if (!range) return 0;
  const lines = content.split('\n');
  return lines.slice(0, range.endLine).reduce((offset, line) => offset + line.length + 1, 0);
}

/**
 * Frozen four-note update protocol: exactly four distinct notes, each with indexed attributes and body text; the
 * non-indexed and indexed-attribute edits change only frontmatter, and the body edit is a single-line literal inside
 * body text that is not a heading.
 */
export function validateUpdateProtocol(updates, contents) {
  if (updates.notes.length !== UPDATE_NOTE_COUNT) {
    throw new Error(`Update scenarios need exactly ${UPDATE_NOTE_COUNT} distinct notes; found ${updates.notes.length}.`);
  }
  for (const notePath of updates.notes) {
    const content = contents.get(notePath);
    const end = frontmatterEnd(content);
    const attributes = readAttributes(content);
    if (attributes.status !== 'valid' || attributes.fields.length === 0 || !content.slice(end).trim()) {
      throw new Error(`Update note ${notePath} needs indexed frontmatter attributes and body text.`);
    }
    for (const [name, [oldText]] of [['excludedEdits', updates.edits.nonTargetFrontmatter[notePath]],
      ['attributeEdits', updates.edits.indexedAttribute[notePath]]]) {
      if (content.indexOf(oldText) + oldText.length > end) throw new Error(`${name} for ${notePath} must edit only the frontmatter.`);
    }
    const [oldText, newText] = updates.edits.body[notePath];
    const index = content.indexOf(oldText);
    if (index < end) throw new Error(`bodyEdits for ${notePath} must edit body text, not frontmatter.`);
    if (/[\r\n]/.test(oldText) || /[\r\n]/.test(newText)) throw new Error(`bodyEdits for ${notePath} must stay within one line.`);
    // The whole resulting physical line (unchanged prefix + replacement + unchanged suffix) must not become a heading.
    const lines = physicalLines(content);
    const target = lines.findLastIndex((line) => line.start <= index);
    const { start, text } = lines[target];
    const resulting = text.slice(0, index - start) + newText + text.slice(index - start + oldText.length);
    const before = lines.map((line) => line.text);
    const after = before.map((line, position) => (position === target ? resulting : line));
    if (chunkerHeading(before, target) || chunkerHeading(after, target)) {
      throw new Error(`bodyEdits for ${notePath} must not edit a heading or turn its line into one.`);
    }
  }
}

export async function loadDataset(root, expectedCombinedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedCombinedSha256 ?? '')) throw new Error('An expected combined SHA-256 is required.');
  const datasetRoot = path.resolve(root);
  const corpus = path.join(datasetRoot, 'corpus');
  const paths = (await markdownFiles(corpus)).sort();
  if (paths.length === 0) throw new Error('The dataset corpus has no Markdown notes.');
  const rawFiles = new Map();
  const notes = [];
  for (const notePath of paths) {
    if (!validRelativePath(notePath)) throw new Error(`Invalid note path: ${notePath}`);
    const bytes = await readFile(path.join(corpus, ...notePath.split('/')));
    rawFiles.set(`corpus/${notePath}`, bytes);
    notes.push({ path: notePath, content: bytes.toString('utf8').replace(/\r\n/g, '\n') });
  }
  const questionBytes = await readFile(path.join(datasetRoot, 'questions.json'));
  rawFiles.set('questions.json', questionBytes);
  const parsed = JSON.parse(questionBytes.toString('utf8'));
  const combined = combinedLoaderHash(notes, parsed.questions, parsed.updateScenarios);
  if (combined !== expectedCombinedSha256) {
    throw new Error(`Dataset combined hash ${combined} does not match the expected value; experiments are blocked.`);
  }
  const files = Object.fromEntries([...rawFiles].map(([name, bytes]) => [name, sha256(bytes)]));
  let manifestBytes;
  try { manifestBytes = await readFile(path.join(datasetRoot, 'manifest.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Dataset manifest.json is missing; experiments are blocked.');
    throw error;
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const listed = Object.keys(manifest.files ?? {}).sort();
  if (JSON.stringify(listed) !== JSON.stringify(Object.keys(files).sort()) ||
      listed.some((name) => manifest.files[name] !== files[name])) {
    throw new Error('Dataset files do not match manifest.json; experiments are blocked.');
  }

  const contents = new Map(notes.map((note) => [note.path, note.content]));
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) throw new Error('questions.json has no questions.');
  const ids = new Set();
  const questions = parsed.questions.map((question) => {
    if (typeof question.id !== 'string' || !question.id || ids.has(question.id) || typeof question.group !== 'string' ||
        !question.group || typeof question.question !== 'string' || !question.question.trim() || !contents.has(question.path)) {
      throw new Error(`Question ${question.id ?? '(no id)'} is invalid or names an unknown note.`);
    }
    ids.add(question.id);
    return { id: question.id, group: question.group, question: question.question, path: question.path,
      ...goldLineOf(question, contents.get(question.path)) };
  });
  const updates = adaptUpdateScenarios(parsed.updateScenarios, contents);
  validateUpdateProtocol(updates, contents);
  return {
    root: datasetRoot,
    notes,
    questions,
    updates,
    digests: {
      combinedLoaderSha256: combined,
      questionsJsonSha256: files['questions.json'],
      fixtureManifestSha256: sha256(manifestBytes),
      files,
    },
  };
}
