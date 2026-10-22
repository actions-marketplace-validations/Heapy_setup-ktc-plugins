import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boolean, cacheKeys, inspect, parseWrapper, platformTarget, prepare, readOnly } from '../scripts/setup.mjs';

const fixture = fileURLToPath(new URL('fixtures/consumer/', import.meta.url));
async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'setup-plugins-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'consumer with spaces');
  await cp(fixture, directory, { recursive: true, filter: source => !source.includes(`${path.sep}plugins${path.sep}bcv`) });
  return { directory, env: { GITHUB_WORKSPACE: directory, RUNNER_TEMP: root,
    GITHUB_ENV: path.join(root, 'env'), GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_EVENT_NAME: 'pull_request' } };
}

test('published Unix and Windows launchers agree', async () => {
  const unix = parseWrapper(await readFile(path.join(fixture, 'ktc-plugins'), 'utf8'));
  const windows = parseWrapper(await readFile(path.join(fixture, 'ktc-plugins.bat'), 'utf8'), true);
  assert.equal(unix.version, '0.3.1');
  assert.equal(windows.version, unix.version);
  assert.equal(Object.keys(unix.pins).length, 3);
});

test('development templates, duplicate pins and duplicate versions fail', async () => {
  const text = await readFile(path.join(fixture, 'ktc-plugins'), 'utf8');
  assert.throws(() => parseWrapper(text.replace(/sha='[a-f0-9]{64}'/, "sha='UNRELEASED'")));
  assert.throws(() => parseWrapper(text + "\nversion='0.3.1' # VERSION\n"));
  assert.throws(() => parseWrapper(text.replace('SHA_LINUX_X64', 'SHA_MACOS_ARM64')));
});

test('only supported native platforms are accepted', () => {
  for (const [os, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['win32', 'x64']]) assert.ok(platformTarget(os, arch));
  assert.throws(() => platformTarget('darwin', 'x64'), /Unsupported host/);
  assert.throws(() => platformTarget('win32', 'arm64'), /Unsupported host/);
});

test('cache defaults never save for pull requests or unknown events', () => {
  for (const event of ['pull_request', 'pull_request_target', undefined, 'release']) assert.equal(readOnly('auto', event), true);
  for (const event of ['push', 'schedule', 'workflow_dispatch']) assert.equal(readOnly('auto', event), false);
  assert.equal(readOnly('false', 'pull_request'), false);
  assert.equal(readOnly('true', 'push'), true);
  assert.throws(() => boolean('yes', 'sync'));
});

test('cache identities isolate platforms, wrappers and lockfiles', () => {
  const a = cacheKeys('linux-x64', 'wrapper1', 'lock1');
  const b = cacheKeys('linux-x64', 'wrapper1', 'lock2');
  assert.equal(a.prefix, b.prefix);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.prefix, cacheKeys('linux-arm64', 'wrapper1', 'lock1').prefix);
  assert.notEqual(a.prefix, cacheKeys('linux-x64', 'wrapper2', 'lock1').prefix);
  assert.throws(() => cacheKeys('linux-x64', 'wrapper1', 'lock1', 'bad\nkey'));
});

test('prepare exports external caches and the pinned version with spaces in the project path', async t => {
  const { directory, env } = await project(t);
  const result = await prepare(env);
  assert.equal(result.version, '0.3.1');
  assert.ok(!result.cacheRoot.startsWith(directory));
  assert.match(await readFile(env.GITHUB_ENV, 'utf8'), /KTC_PLUGINS_BINARY_CACHE=/);
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /cache-read-only=true/);
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /version=0.3.1/);
});

test('wrapper version mismatch and binary override are rejected', async t => {
  const { directory, env } = await project(t);
  await assert.rejects(inspect({ ...env, KTC_PLUGINS_BINARY: '/tmp/custom' }), /bypasses/);
  const file = path.join(directory, 'ktc-plugins.bat');
  await writeFile(file, (await readFile(file, 'utf8')).replace('ktc_version=0.3.1', 'ktc_version=0.3.2'));
  await assert.rejects(inspect(env), /different versions/);
});

test('missing lockfile and workspace escape fail before bootstrap', async t => {
  const { directory, env } = await project(t);
  await assert.rejects(inspect({ ...env, INPUT_DIRECTORY: '..' }), /inside the workspace/);
  await rm(path.join(directory, 'ktc-plugins.lock.yaml'));
  await assert.rejects(prepare(env), /ENOENT/);
});

test('cache disabled still supplies local caches without enabling Actions cache', async t => {
  const { env } = await project(t);
  await prepare({ ...env, INPUT_CACHE: 'false' });
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /cache-enabled=false/);
});

test('cache roots inside the checkout are rejected', async t => {
  const { directory, env } = await project(t);
  await assert.rejects(prepare({ ...env, RUNNER_TEMP: directory }), /outside the workspace/);
});
