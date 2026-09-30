export interface ChunkLocation {
  startLine: number;
  endLine: number;
}

export interface MarkdownChunk {
  chunk_id: string;
  source_id: string;
  content: string;
  location: ChunkLocation;
  content_hash: string;
}

function hash(value: string): string {
  let result = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    result ^= BigInt(value.charCodeAt(index));
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result.toString(16).padStart(16, '0');
}

/** Splits a Markdown source at headings outside fenced code blocks. Lines are one-based. */
export function chunkMarkdown(sourceId: string, markdown: string): MarkdownChunk[] {
  if (!sourceId.trim()) throw new Error('A source ID is required to chunk Markdown.');

  const lines = markdown.split(/\r\n|\n|\r/);
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let fence: { marker: string; length: number } | undefined;

  function append(end: number): void {
    const first = lines.findIndex((line, index) => index >= start && index < end && line.trim() !== '');
    if (first < 0) return;
    let last = end - 1;
    while (lines[last].trim() === '') last -= 1;
    const content = lines.slice(first, last + 1).join('\n');
    const location = { startLine: first + 1, endLine: last + 1 };
    const content_hash = hash(content);
    chunks.push({
      chunk_id: hash(`${sourceId}\0${location.startLine}\0${content}`),
      source_id: sourceId,
      content,
      location,
      content_hash,
    });
  }

  lines.forEach((line, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
    }
    if (!fence && /^ {0,3}#{1,6}(?:\s|$)/.test(line) && index > start) {
      append(index);
      start = index;
    }
  });
  append(lines.length);
  return chunks;
}
