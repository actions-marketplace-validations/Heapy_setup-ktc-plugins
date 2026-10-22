import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoke, prepare, restore } from '../scripts/setup.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'plugins-integration-'));
try {
  const directory = path.join(root, 'consumer with spaces');
  await cp(fileURLToPath(new URL('fixtures/consumer/', import.meta.url)), directory, {
    recursive: true, filter: source => !source.includes(`${path.sep}plugins${path.sep}bcv`),
  });
  for (const args of [['init', '--quiet'], ['add', '.']]) {
    const git = spawnSync('git', args, { cwd: directory, stdio: 'inherit' });
    assert.equal(git.status, 0);
  }
  const env = { ...process.env, GITHUB_WORKSPACE: directory, RUNNER_TEMP: root,
    GITHUB_ENV: path.join(root, 'env'), GITHUB_OUTPUT: path.join(root, 'output') };
  delete env.KTC_PLUGINS_BINARY;
  const prepared = await prepare(env);
  Object.assign(env, Object.fromEntries((await readFile(env.GITHUB_ENV, 'utf8')).trim().split('\n').map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  })));
  const lockPath = path.join(directory, 'ktc-plugins.lock.yaml');
  const lockBefore = await readFile(lockPath, 'utf8');
  await restore(env);
  const source = path.join(directory, 'plugins/bcv/module.yaml');
  const pristine = await readFile(source, 'utf8');
  assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
  await rm(path.join(directory, 'plugins/bcv'), { recursive: true });
  invoke(prepared.wrapper, ['sync', '--offline'], directory, env);
  invoke(prepared.wrapper, ['verify'], directory, env);
  assert.equal(await readFile(source, 'utf8'), pristine);
  await writeFile(source, pristine + '\n# local edit\n');
  await assert.rejects(restore(env), /failed/);
  assert.equal(await readFile(source, 'utf8'), pristine + '\n# local edit\n');
  await writeFile(source, pristine);
  await writeFile(lockPath, lockBefore.replace(/declarationSha256: '[a-f0-9]{64}'/, `declarationSha256: '${'0'.repeat(64)}'`));
  await assert.rejects(restore(env), /failed/);
  await writeFile(lockPath, lockBefore);
  const binaries = await readdir(prepared.binaryCache, { recursive: true });
  const binary = binaries.find(name => path.basename(name).startsWith('ktc-plugins-'));
  assert.ok(binary, 'launcher downloaded a native binary');
  await writeFile(path.join(prepared.binaryCache, binary), 'corrupt cached executable');
  await assert.rejects(restore(env), /failed/);
  assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
  console.log('PASS: clean restore, offline restore, lock preservation, modified-source refusal, stale-lock refusal, corrupt-cache refusal');
} finally { await rm(root, { recursive: true, force: true }); }
