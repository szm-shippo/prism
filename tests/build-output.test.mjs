import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('distribution includes the yaml@2.9.1 license with its package heading', async () => {
  const [distributedLicense, packageLicense] = await Promise.all([
    readFile(new URL('../target/MAIN_LICENSES.txt', import.meta.url), 'utf8'),
    readFile(new URL('../node_modules/yaml/LICENSE', import.meta.url), 'utf8'),
  ]);

  assert.equal(distributedLicense, `yaml@2.9.1\n${packageLicense}`);
});
