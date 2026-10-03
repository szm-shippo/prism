import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/application/conversation-history.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { selectHistory } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('history keeps at most six complete recent exchanges in chronological order without mutating input', () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  const selected = selectHistory(history);
  assert.deepEqual(selected.exchanges, history.slice(2));
  assert.equal(selected.omitted, 2);
  selected.exchanges[0].question = 'changed';
  assert.equal(history[2].question, 'q2');
  assert.deepEqual(selectHistory([]), { exchanges: [], omitted: 0 });
});

test('history enforces the UTF-8 JSON byte boundary and omits an oversized pair and everything before it', () => {
  const overhead = Buffer.byteLength(JSON.stringify([{ question: '', answer: '' }]));
  const exact = { question: 'x'.repeat(12000 - overhead), answer: '' };
  assert.equal(selectHistory([exact]).exchanges.length, 1);
  assert.equal(selectHistory([{ ...exact, answer: 'x' }]).omitted, 1);
  const large = { question: '日本語'.repeat(1400), answer: 'answer' };
  const small = { question: 'recent', answer: 'answer' };
  assert.deepEqual(selectHistory([small, large, small]), { exchanges: [small], omitted: 2 });
});
