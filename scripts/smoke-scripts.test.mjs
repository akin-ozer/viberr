import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('package scripts expose required entry points', async () => {
  const packagePath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

  for (const script of ['dev', 'test', 'e2e', 'seed']) {
    assert.equal(typeof pkg.scripts?.[script], 'string', `${script} is a script`);
    assert.ok(pkg.scripts[script].trim(), `${script} is non-empty`);
  }
});
