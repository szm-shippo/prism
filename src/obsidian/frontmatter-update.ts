import { isMap, isNode, isScalar, parseDocument, visit, type CST, type Pair } from 'yaml';
import type { SearchFrontmatter } from '../core/application/search-frontmatter';

type FrontmatterErrorReason = 'invalid_yaml' | 'unsupported';

export class FrontmatterError extends Error {
  constructor(readonly reason: FrontmatterErrorReason) {
    super(reason === 'invalid_yaml' ? 'The note frontmatter is not valid YAML.' : 'The note frontmatter cannot be updated safely.');
    this.name = 'FrontmatterError';
  }
}

/** A single editor change from `from` to `to` that turns the note into `content`. */
interface FrontmatterUpdate {
  from: number;
  to: number;
  text: string;
  content: string;
}

export interface ParsedNote {
  body: string;
  update(metadata: SearchFrontmatter): FrontmatterUpdate;
}

const MANAGED_KEYS = ['prism_summary', 'prism_keywords', 'prism_aliases'] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];
const BOM = '﻿';
const PARSE_OPTIONS = { keepSourceTokens: true, uniqueKeys: true, stringKeys: true, prettyErrors: false };

interface Span {
  from: number;
  to: number;
}

interface Frontmatter {
  yaml: string;
  yamlStart: number;
  lineBreak: string;
  values: Record<string, unknown>;
  /** Each top-level Prism value, from just after its `:` to the end of the value. */
  spans: Map<ManagedKey, Span>;
}

interface LocatedNote {
  /** Offset after an optional byte order mark. */
  start: number;
  bodyStart: number;
  frontmatter?: Frontmatter;
}

function invalidYaml(): never {
  throw new FrontmatterError('invalid_yaml');
}

function unsupported(): never {
  throw new FrontmatterError('unsupported');
}

function isManagedKey(key: unknown): key is ManagedKey {
  return MANAGED_KEYS.includes(key as ManagedKey);
}

function commentOffsets(item: CST.CollectionItem): number[] {
  const offsets: number[] = [];
  const tokens = (list: readonly CST.Token[] | undefined) => list?.forEach(token);
  const token = (node: CST.Token | null | undefined): void => {
    switch (node?.type) {
      case 'comment': offsets.push(node.offset); break;
      case 'block-map': case 'block-seq': node.items.forEach(entry); break;
      case 'flow-collection': token(node.start); node.items.forEach(entry); tokens(node.end); break;
      case 'block-scalar': tokens(node.props); break;
      case 'alias': case 'scalar': case 'single-quoted-scalar': case 'double-quoted-scalar': tokens(node.end); break;
    }
  };
  const entry = (next: CST.CollectionItem) => {
    tokens(next.start);
    token(next.key);
    tokens(next.sep);
    token(next.value);
  };
  entry(item);
  return offsets;
}

function valueSpan(yaml: string, pair: Pair): Span {
  const item = pair.srcToken;
  const indicator = item?.sep?.find((token) => token.type === 'map-value-ind');
  if (!item || !indicator || !isNode(pair.value) || !pair.value.range) unsupported();
  const from = indicator.offset + indicator.source.length;
  let to = pair.value.range[1];
  while (to > from && /[ \t\r\n]/.test(yaml[to - 1])) to -= 1;
  // Comments inside the old value would be lost, and text right after it would merge with the new value.
  if (to < from || (to < yaml.length && !/[ \t\r\n]/.test(yaml[to])) ||
      commentOffsets(item).some((offset) => offset >= from && offset < to)) unsupported();
  return { from, to };
}

function readProperties(yaml: string): Pick<Frontmatter, 'values' | 'spans'> {
  const document = parseDocument(yaml, PARSE_OPTIONS);
  if (document.errors.length > 0) invalidYaml();
  if (document.warnings.length > 0 || document.directives.docStart || document.directives.docEnd) unsupported();
  // Anchors, aliases, tags and merge keys tie values to other text or depend on the reading parser.
  let portable = true;
  visit(document, {
    Alias: () => {
      portable = false;
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (!node.anchor && !node.tag) return;
      portable = false;
      return visit.BREAK;
    },
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || pair.key.value !== '<<') return;
      portable = false;
      return visit.BREAK;
    },
  });
  if (!portable) unsupported();

  const root = document.contents;
  if (root === null) return { values: {}, spans: new Map() };
  if (!isMap(root)) invalidYaml();
  if (root.srcToken?.type !== 'block-map' || root.srcToken.indent !== 0) unsupported();
  const spans = new Map<ManagedKey, Span>();
  for (const pair of root.items) {
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    if (isManagedKey(key)) spans.set(key, valueSpan(yaml, pair));
  }
  let values: Record<string, unknown>;
  try {
    values = document.toJS();
  } catch {
    unsupported();
  }
  return { values, spans };
}

function locate(content: string): LocatedNote {
  const start = content.startsWith(BOM) ? BOM.length : 0;
  const opening = /^---(\r?\n)/.exec(content.slice(start, start + 5));
  if (!opening) {
    // A first line that only resembles a delimiter may be read as frontmatter elsewhere.
    if (content.startsWith('---', start)) unsupported();
    return { start, bodyStart: start };
  }
  const yamlStart = start + opening[0].length;
  for (let lineStart = yamlStart; lineStart < content.length;) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline + 1;
    if (/^---\r?\n?$/.test(content.slice(lineStart, lineEnd))) {
      const yaml = content.slice(yamlStart, lineStart);
      return { start, bodyStart: lineEnd,
        frontmatter: { yaml, yamlStart, lineBreak: opening[1], ...readProperties(yaml) } };
    }
    lineStart = lineEnd;
  }
  unsupported();
}

function yamlValue(value: string | readonly string[]): string {
  // JSON strings are YAML double-quoted scalars, which every YAML version reads back as the same string.
  return typeof value === 'string' ? JSON.stringify(value) : `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) =>
    key === rightEntries[index][0] && sameValue(value, rightEntries[index][1]));
}

function buildUpdate(content: string, note: LocatedNote, metadata: SearchFrontmatter): { update: FrontmatterUpdate; added: string } {
  const frontmatter = note.frontmatter;
  const lineBreak = frontmatter?.lineBreak ?? /\r?\n/.exec(content)?.[0] ?? '\n';
  const added = MANAGED_KEYS.filter((key) => !frontmatter?.spans.has(key))
    .map((key) => `${key}: ${yamlValue(metadata[key])}${lineBreak}`).join('');
  if (!frontmatter) {
    const text = `---${lineBreak}${added}---${lineBreak}`;
    return { added, update: { from: note.start, to: note.start, text,
      content: content.slice(0, note.start) + text + content.slice(note.start) } };
  }

  const edits = [...frontmatter.spans].map(([key, span]) => ({ ...span, text: ` ${yamlValue(metadata[key])}` }));
  if (added) edits.push({ from: frontmatter.yaml.length, to: frontmatter.yaml.length, text: added });
  let yaml = '';
  let copied = 0;
  for (const edit of edits) {
    yaml += frontmatter.yaml.slice(copied, edit.from) + edit.text;
    copied = edit.to;
  }
  yaml += frontmatter.yaml.slice(copied);
  const yamlEnd = frontmatter.yamlStart + frontmatter.yaml.length;
  const updated = content.slice(0, frontmatter.yamlStart) + yaml + content.slice(yamlEnd);
  const from = frontmatter.yamlStart + edits[0].from;
  const to = frontmatter.yamlStart + edits[edits.length - 1].to;
  return { added, update: { from, to, text: updated.slice(from, to + updated.length - content.length), content: updated } };
}

function verifyUpdate(content: string, note: LocatedNote, update: FrontmatterUpdate, added: string,
  metadata: SearchFrontmatter): void {
  let written: LocatedNote;
  try {
    written = locate(update.content);
  } catch {
    unsupported();
  }
  const before = note.frontmatter;
  const after = written.frontmatter;
  if (!after || content.slice(0, update.from) + update.text + content.slice(update.to) !== update.content ||
      update.content.slice(0, written.start) !== content.slice(0, note.start) ||
      update.content.slice(written.bodyStart) !== content.slice(note.bodyStart)) unsupported();

  const expected: Record<string, unknown> = { ...before?.values };
  for (const key of MANAGED_KEYS) expected[key] = metadata[key];
  if (!sameValue(after.values, expected)) unsupported();

  // Putting the old Prism values back where the parser now finds the new ones must restore the original YAML.
  let restored = '';
  let copied = 0;
  for (const key of MANAGED_KEYS) {
    const span = after.spans.get(key);
    if (!span || after.yaml.slice(span.from, span.to) !== ` ${yamlValue(metadata[key])}`) unsupported();
  }
  for (const [key, span] of after.spans) {
    const original = before?.spans.get(key);
    if (!before || !original) continue;
    restored += after.yaml.slice(copied, span.from) + before.yaml.slice(original.from, original.to);
    copied = span.to;
  }
  restored += after.yaml.slice(copied);
  if (restored !== (before?.yaml ?? '') + added) unsupported();
}

export function parseNote(content: string): ParsedNote {
  const note = locate(content);
  return {
    body: content.slice(note.bodyStart),
    update(metadata) {
      const { update, added } = buildUpdate(content, note, metadata);
      verifyUpdate(content, note, update, added, metadata);
      return update;
    },
  };
}
