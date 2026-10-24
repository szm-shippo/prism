// Search projections for the #99 frontmatter comparison. Citation chunks are never modified here:
// every function derives a separate search text from a copy of the chunk content.
import { parseDocument } from 'yaml';

export const INDEXED_FIELDS = ['title', 'aliases', 'tags', 'summary', 'description', 'prism_summary',
  'prism_keywords', 'prism_aliases'];
export const MAX_MODEL_TOKENS = 512;
export const ATTRIBUTE_TOKEN_BUDGET = 384;
export const HEADING_SEPARATOR = '\n\n';

const LINE_BREAK = /\r\n|\n|\r/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ENGLISH_CUE = /(?<![\p{L}\p{N}_])(?:title|alias|aliases|tag|tags|summary|description|keyword|keywords)(?![\p{L}\p{N}_])/u;
const JAPANESE_CUE = /タイトル|別名|タグ|要約|概要|説明|キーワード/u;

/** Physical 1-based last line of a complete leading `---` block, or undefined when there is none. */
export function frontmatterRange(markdown) {
  const lines = markdown.split(LINE_BREAK);
  if (lines[0].replace(/^﻿/u, '') !== '---') return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) return undefined;
  return { endLine: closing + 1, yaml: lines.slice(1, closing).join('\n') };
}

function normalizeValue(value, field) {
  let text = value.normalize('NFKC').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (field === 'tags' || field === 'prism_keywords') text = text.replace(/^#+/u, '').trim();
  return text;
}

function fieldValues(field, value) {
  // Obsidian accepts a scalar tag list separated by commas or spaces.
  const raw = typeof value === 'string' ? (field === 'tags' ? value.split(/[,\s]+/u) : [value])
    : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  const seen = new Set();
  const values = [];
  for (const item of raw) {
    const normalized = normalizeValue(item, field);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }
  return values;
}

/**
 * Reads only the eight indexed top-level fields. Invalid or duplicate-key YAML yields no attributes;
 * the diagnostic is a fixed code so note text never reaches logs.
 */
export function readAttributes(markdown) {
  const range = frontmatterRange(markdown);
  if (!range) return { status: 'none', fields: [] };
  let data;
  try {
    const document = parseDocument(range.yaml, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) return { status: 'invalid', diagnostic: 'invalid-yaml', fields: [] };
    data = document.toJS({ maxAliasCount: 100 });
  } catch {
    return { status: 'invalid', diagnostic: 'invalid-yaml', fields: [] };
  }
  if (data === null || data === undefined) return { status: 'valid', fields: [] };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'invalid', diagnostic: 'not-a-mapping', fields: [] };
  }
  const fields = INDEXED_FIELDS.flatMap((field) => {
    if (!Object.hasOwn(data, field)) return [];
    const values = fieldValues(field, data[field]);
    return values.length ? [{ field, values }] : [];
  });
  return { status: 'valid', fields };
}

/** `field: value` lines in the fixed field order, with the character offset of each line. */
export function serializeAttributes(fields) {
  let offset = 0;
  const lines = fields.map(({ field, values }) => {
    const text = `${field}: ${values.join(', ')}`;
    const line = { field, start: offset, labelEnd: offset + field.length + 2, end: offset + text.length, text };
    offset += text.length + 1;
    return line;
  });
  return { text: lines.map((line) => line.text).join('\n'), lines };
}

/**
 * The chunk's search text with the leading frontmatter lines removed. Returns undefined for a chunk that
 * contains only frontmatter, so it can never be retrieved or cited through body search.
 */
export function bodyProjection(chunk, range) {
  if (!range || chunk.location.startLine > range.endLine) return chunk.content;
  if (chunk.location.endLine <= range.endLine) return undefined;
  const text = chunk.content.split('\n').slice(range.endLine - chunk.location.startLine + 1).join('\n');
  return text.trim() ? text : undefined;
}

/** First ATX heading outside fenced code in a body projection, or an empty string. */
export function sectionHeading(projection) {
  let fence;
  for (const line of projection.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence && HEADING.test(line)) return line.trim();
  }
  return '';
}

export function routeQuery(query) {
  const normalized = query.normalize('NFKC').toLowerCase();
  return ENGLISH_CUE.test(normalized) || JAPANESE_CUE.test(normalized) ? 'explicit' : 'implicit';
}

export const PREFIX_BATCH = 64;

/**
 * Longest code-point prefix whose own tokenization (including special tokens) is within `limit`.
 * `tokenize` maps texts to token ID arrays. Token counts need not grow monotonically with prefix length, so
 * prefixes are checked exhaustively from the longest down; the returned IDs are those of the returned text.
 */
export async function projectPrefix(text, limit, tokenize) {
  const [ids] = await tokenize([text]);
  if (ids.length <= limit) {
    return { text, ids, originalTokens: ids.length, projectedTokens: ids.length, discardedTokens: 0, truncated: false,
      checkedPrefixes: 0 };
  }
  const points = [...text];
  let checked = 0;
  for (let longest = points.length - 1; longest >= 0; longest -= PREFIX_BATCH) {
    const lengths = [];
    for (let length = longest; length > longest - PREFIX_BATCH && length >= 0; length -= 1) lengths.push(length);
    const candidates = await tokenize(lengths.map((length) => points.slice(0, length).join('')));
    const index = candidates.findIndex((candidate) => candidate.length <= limit);
    checked += index >= 0 ? index + 1 : lengths.length;
    if (index >= 0) {
      return { text: points.slice(0, lengths[index]).join(''), ids: candidates[index], originalTokens: ids.length,
        projectedTokens: candidates[index].length, discardedTokens: ids.length - candidates[index].length, truncated: true,
        checkedPrefixes: checked };
    }
  }
  throw new Error('No prefix fits the model token limit.');
}

/** Which attribute fields survive in a projected prefix of a text that starts with the attribute lines. */
export function fieldCoverage(lines, projectedLength) {
  return lines.map(({ field, labelEnd, end }) => ({
    field,
    represented: projectedLength > labelEnd,
    complete: projectedLength >= end,
  }));
}

/**
 * Model inputs for one source under config C or A. Body inputs share the same 512-token prefix;
 * A adds one attribute+heading input per body-bearing chunk.
 */
export async function sourceModelInputs(config, markdown, chunks, tokenize) {
  if (config !== 'C' && config !== 'A') throw new Error('Unknown search config.');
  const range = frontmatterRange(markdown);
  const attributes = readAttributes(markdown);
  const body = [];
  for (const chunk of chunks) {
    const projection = bodyProjection(chunk, range);
    if (projection === undefined) continue;
    body.push({ kind: 'body', chunkId: chunk.chunk_id, projection,
      input: await projectPrefix(projection, MAX_MODEL_TOKENS, tokenize) });
  }
  const serialized = serializeAttributes(attributes.fields);
  const metadata = [];
  if (attributes.fields.length > 0 && body.length > 0) {
    if (config === 'A') {
      const prefix = await projectPrefix(serialized.text, ATTRIBUTE_TOKEN_BUDGET, tokenize);
      for (const item of body) {
        const heading = sectionHeading(item.projection);
        const text = heading ? `${prefix.text}${HEADING_SEPARATOR}${heading}` : prefix.text;
        const input = await projectPrefix(text, MAX_MODEL_TOKENS, tokenize);
        metadata.push({ kind: 'attribute-chunk', chunkId: item.chunkId, heading, input,
          attributeTokens: { original: prefix.originalTokens, projected: prefix.projectedTokens },
          coverage: fieldCoverage(serialized.lines, Math.min(prefix.text.length, input.text.length)) });
      }
    }
  }
  return { frontmatter: range ? { endLine: range.endLine } : undefined, attributes, body, metadata };
}
