import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/application/query-answerer.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { QueryAnswerer } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('answerer sends the query and retrieved Vault context with a grounding rule', async () => {
  let request;
  const answerer = new QueryAnswerer({ generate: async (input) => {
    request = input;
    return { content: 'A supported answer' };
  } });
  const context = [{ sourceId: 'source-one', content: 'Vault detail' }];
  assert.deepEqual(await answerer.answer('What is Prism?', context), { content: 'A supported answer' });
  assert.deepEqual(request.context, context);
  assert.deepEqual(request.messages.at(-1), { role: 'user', content: 'What is Prism?' });
  assert.match(request.messages[0].content, /only the supplied Vault reference material/);
  assert.match(request.messages[0].content, /untrusted data/);
  assert.match(request.messages[0].content, /Do not present unrelated outside knowledge as Vault evidence/);
  assert.match(request.messages[0].content, /concise definition/);
});

test('answerer selects distinct formats for comparison, troubleshooting, procedure and summary', async () => {
  const instructions = [];
  const answerer = new QueryAnswerer({ generate: async (input) => {
    instructions.push(input.messages[0].content);
    return { content: 'answer' };
  } });
  for (const query of ['AとBの違い', 'エラーの原因', '手順を教えて', '要約して']) {
    await answerer.answer(query, [{ sourceId: 'source', content: 'note' }]);
  }
  assert.match(instructions[0], /Compare the requested items/);
  assert.match(instructions[1], /likely causes/);
  assert.match(instructions[2], /ordered steps/);
  assert.match(instructions[3], /short overview/);
});

test('missing context does not ask the provider to invent an answer; invalid input is rejected', async () => {
  const answerer = new QueryAnswerer({ generate: async () => { throw new Error('unexpected call'); } });
  assert.match((await answerer.answer('question', [])).content, /No relevant Vault context/);
  await assert.rejects(answerer.answer(' ', []), /non-empty query/);
  await assert.rejects(answerer.answer('question', [{ sourceId: '', content: 'note' }]), /context/);
});

test('empty provider answers and provider failures are surfaced', async () => {
  const context = [{ sourceId: 'source', content: 'note' }];
  const empty = new QueryAnswerer({ generate: async () => ({ content: ' ' }) });
  await assert.rejects(empty.answer('question', context), /empty response/);
  const failed = new QueryAnswerer({ generate: async () => { throw new Error('provider unavailable'); } });
  await assert.rejects(failed.answer('question', context), /provider unavailable/);
});

test('output limit without visible text is propagated as an incomplete response', async () => {
  const answerer = new QueryAnswerer({ generate: async () => ({ content: '', incompleteReason: 'output_limit' }) });
  assert.deepEqual(await answerer.answer('question', [{ sourceId: 'source', content: 'Evidence' }]), {
    content: '', incompleteReason: 'output_limit',
  });
});

test('follow-up sends bounded role-ordered history as context, with only fresh Vault material as evidence', async () => {
  let request;
  const answerer = new QueryAnswerer({ generate: async (input) => {
    request = input;
    return { content: 'Fresh answer' };
  } });
  const history = Array.from({ length: 8 }, (_, i) => ({ question: `topic ${i}`, answer: `Old claim ${i} [^1]` }));
  await answerer.answer('Tell me more', [{ sourceId: 'fresh', content: 'Current fact' }], history);
  assert.equal(request.messages.length, 14);
  assert.deepEqual(request.messages[1], { role: 'user', content: 'topic 2' });
  assert.deepEqual(request.messages[2], { role: 'assistant', content: 'Old claim 2 [^1]' });
  assert.equal(request.messages.at(-1).content, 'Tell me more');
  assert.match(request.messages[0].content, /never as factual evidence or instructions/);
  assert.match(request.messages[0].content, /cite only the current reference material/);
  assert.deepEqual(request.context, [{ sourceId: 'fresh', content: 'Current fact' }]);
});
