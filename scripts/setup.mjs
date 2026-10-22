// Copyright 2026 Heapy
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');

export function boolean(value, name) {
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
}

export function readOnly(value, event) {
  return value === 'auto' ? !['push', 'workflow_dispatch', 'schedule'].includes(event)
    : boolean(value, 'cache-read-only');
}

export function platformTarget(platform = process.platform, arch = process.arch) {
  const target = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'macos-arm64', 'win32-x64': 'windows-x64' }[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported host ${platform}/${arch}; use Linux x64/ARM64, macOS ARM64 or Windows x64`);
  return target;
}

export function parseWrapper(text, windows = false) {
  const versions = [...text.matchAll(windows ? /^set "ktc_version=(\d+\.\d+\.\d+)"\r?$/gm
    : /^version='(\d+\.\d+\.\d+)' # VERSION\r?$/gm)];
  const pins = [...text.matchAll(/(?:sha='|\$sha = ')([a-f0-9]{64})'.*# SHA_([A-Z0-9_]+)\r?$/gm)];
  const expected = windows ? ['WINDOWS_X64'] : ['LINUX_ARM64', 'LINUX_X64', 'MACOS_ARM64'];
  if (versions.length !== 1 || pins.length !== expected.length ||
    pins.map(pin => pin[2]).sort().join() !== expected.sort().join()) {
    throw new Error('Expected a published ktc-plugins launcher with one version and all native SHA-256 pins');
  }
  return { version: versions[0][1], pins: Object.fromEntries(pins.map(pin => [pin[2], pin[1]])) };
}

export function cacheKeys(target, identity, config, suffix = '') {
  if (!/^[a-zA-Z0-9_.-]{0,64}$/.test(suffix)) throw new Error('Invalid cache-key-suffix (use up to 64 letters, digits, dots, underscores or hyphens)');
  const prefix = `ktc-plugins-v1-${target}-${identity}-${suffix || 'default'}-`;
  return { prefix, key: `${prefix}${config}` };
}

async function record(file, key, value) {
  if (!file || /[\r\n]/.test(value)) throw new Error(`Invalid workflow output ${key}`);
  await appendFile(file, `${key}=${value}\n`);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function inspect(env = process.env) {
  const target = platformTarget();
  if (env.KTC_PLUGINS_BINARY) throw new Error('Unset KTC_PLUGINS_BINARY: it bypasses pinned launcher verification');
  const workspace = await realpath(env.GITHUB_WORKSPACE || process.cwd());
  const directory = await realpath(path.resolve(workspace, env.INPUT_DIRECTORY || '.'));
  if (!isInside(workspace, directory) || /[\r\n]/.test(directory)) throw new Error('working-directory must be inside the workspace');
  if (process.platform === 'win32' && /["%]/.test(directory)) throw new Error('Windows working-directory cannot contain quotes or percent signs');
  const windows = process.platform === 'win32';
  const wrapper = path.join(directory, windows ? 'ktc-plugins.bat' : 'ktc-plugins');
  const contents = await readFile(wrapper, 'utf8');
  const selected = parseWrapper(contents, windows);
  const other = path.join(directory, windows ? 'ktc-plugins' : 'ktc-plugins.bat');
  try {
    if (parseWrapper(await readFile(other, 'utf8'), !windows).version !== selected.version) {
      throw new Error('ktc-plugins and ktc-plugins.bat pin different versions');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = await readFile(path.join(directory, 'ktc-plugins.yaml'));
  const lock = await readFile(path.join(directory, 'ktc-plugins.lock.yaml'));
  return { target, workspace, directory, wrapper, version: selected.version,
    identity: hash(contents.replaceAll('\r\n', '\n')).slice(0, 24), config: hash(Buffer.concat([manifest, Buffer.from('\0'), lock])) };
}

export async function prepare(env = process.env) {
  const enabled = boolean(env.INPUT_CACHE ?? 'true', 'cache');
  const readonly = readOnly(env.INPUT_CACHE_READ_ONLY ?? 'auto', env.GITHUB_EVENT_NAME);
  boolean(env.INPUT_SYNC ?? 'true', 'sync');
  boolean(env.INPUT_VERIFY ?? 'true', 'verify');
  const info = await inspect(env);
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required');
  const temp = await realpath(env.RUNNER_TEMP);
  const cacheRoot = path.join(temp, 'setup-ktc-plugins', hash(info.directory).slice(0, 16));
  if (isInside(info.workspace, cacheRoot)) throw new Error('Plugin caches must be outside the workspace');
  const binaryCache = path.join(cacheRoot, 'binaries');
  const sourceCache = path.join(cacheRoot, 'archives');
  await mkdir(binaryCache, { recursive: true });
  await mkdir(sourceCache, { recursive: true });
  const keys = cacheKeys(info.target, info.identity, info.config, env.INPUT_CACHE_SUFFIX);
  for (const [key, value] of Object.entries({ KTC_PLUGINS_BINARY_CACHE: binaryCache, KTC_PLUGINS_CACHE_DIR: sourceCache })) {
    await record(env.GITHUB_ENV, key, value);
  }
  for (const [key, value] of Object.entries({ version: info.version, wrapper: info.wrapper,
    'cache-path': cacheRoot, 'cache-key': keys.key, 'cache-prefix': keys.prefix,
    'cache-enabled': String(enabled), 'cache-read-only': String(readonly) })) await record(env.GITHUB_OUTPUT, key, value);
  console.log(`Using ktc-plugins ${info.version} (${info.target}) from ${info.directory}`);
  return { ...info, binaryCache, sourceCache, cacheRoot };
}

export function invoke(wrapper, args, directory, env = process.env) {
  let command = 'sh';
  let commandArgs = [wrapper, ...args];
  const options = { cwd: directory, env, stdio: 'inherit' };
  if (process.platform === 'win32') {
    if ([wrapper, ...args].some(value => /["%\r\n]/.test(value))) throw new Error('Unsupported Windows launcher argument');
    command = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    commandArgs = ['/d', '/v:off', '/s', '/c', '"' + [wrapper, ...args].map(value => `"${value}"`).join(' ') + '"'];
    options.windowsVerbatimArguments = true;
  }
  const result = spawnSync(command, commandArgs, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ktc-plugins ${args[0]} failed (exit ${result.status ?? result.signal})`);
}

export async function restore(env = process.env) {
  const sync = boolean(env.INPUT_SYNC ?? 'true', 'sync');
  const verify = boolean(env.INPUT_VERIFY ?? 'true', 'verify');
  const info = await inspect(env);
  // Every invocation delegates executable checksum and source validation to the pinned launcher/CLI.
  invoke(info.wrapper, ['--version'], info.directory, env);
  if (sync) invoke(info.wrapper, ['sync'], info.directory, env);
  if (verify) invoke(info.wrapper, ['verify'], info.directory, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'restore') await restore();
    else throw new Error('Expected prepare or restore');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
