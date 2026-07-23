import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = new URL('../package.json', import.meta.url);

test('package version is a non-empty string', async () => {
  const { version } = JSON.parse(await readFile(packageJson, 'utf8'));

  assert.equal(typeof version, 'string');
  assert.ok(version.trim().length > 0);
});
