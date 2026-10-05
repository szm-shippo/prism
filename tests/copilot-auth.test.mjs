import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/copilot-auth.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const module = { exports: {} };
runInNewContext(outputFiles[0].text, { module, exports: module.exports });
const { clearLegacyCopilotCredential, LEGACY_COPILOT_CREDENTIAL_SECRET_ID } = module.exports;

test('startup migration clears the obsolete Prism Copilot OAuth token secret', () => {
  const writes = [];
  clearLegacyCopilotCredential({ setSecret: (...args) => writes.push(args) });
  assert.equal(LEGACY_COPILOT_CREDENTIAL_SECRET_ID, 'prism-copilot-credential');
  assert.deepEqual(writes, [['prism-copilot-credential', '']]);
});
