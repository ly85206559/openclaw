import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const head = '39629c6aa82ce444f14c37fc1d4d47e5c7f661d0';
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 10000 });
assert.equal(git('rev-parse', 'HEAD').trim(), head);
await fs.mkdir(artifacts, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'users-options-proof-'));
const configPath = path.join(scratch, 'openclaw.json');
const config = JSON.stringify({ gateway: { mode: 'local' } }) + '\n';
await fs.writeFile(configPath, config);
const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, OPENCLAW_STATE_DIR: path.join(scratch, 'state'), OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: '1' };
delete env.OPENCLAW_PROFILE;
const { runManagedCommand } = await import(pathToFileURL(path.join(source, 'scripts/lib/managed-child-process.mts')).href);
const receipt = { head, complete: false, cleanup: false, cases: [] };
let failure;
try {
  for (const [name, args, rejected] of [
    ['help-control', ['users', 'list', '--help'], null],
    ['port', ['users', 'list', '--port', '19999', '--json'], '--port'],
    ['password', ['users', 'list', '--password', 'synthetic-fixture', '--json'], '--password'],
  ]) {
    const chunks = [[], []];
    const abort = new AbortController();
    let bytes = 0;
    let exit;
    const status = await runManagedCommand({
      bin: 'pnpm', args: ['--silent', 'openclaw', ...args], cwd: source, env,
      stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 180000,
      requireProcessTreeExit: true, waitForCleanupRelease: true, signal: abort.signal,
      onReady(child) {
        child.once('exit', (code, signal) => { exit = { code, signal }; });
        for (const [i, stream] of [child.stdout, child.stderr].entries()) {
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes <= 4 * 1024 * 1024) chunks[i].push(Buffer.from(chunk));
            else abort.abort(new Error('Proof capture budget exceeded'));
          });
        }
      },
    });
    const stdout = Buffer.concat(chunks[0]).toString('utf8');
    const stderr = Buffer.concat(chunks[1]).toString('utf8');
    await fs.writeFile(path.join(artifacts, `${name}.stdout.txt`), stdout);
    await fs.writeFile(path.join(artifacts, `${name}.stderr.txt`), stderr);
    assert(bytes <= 4 * 1024 * 1024);
    assert.equal(exit.signal, null);
    assert.equal(status, rejected ? 1 : 0);
    assert.equal(exit.code, status);
    if (rejected) {
      const output = JSON.parse(stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.type, 'cli_error');
      assert(output.error.message.includes(`does not recognize option "${rejected}"`));
    } else assert(stdout.includes('List durable user profiles'));
    receipt.cases.push({ name, status, exit, productVerdict: rejected ? 'feature-absent' : 'help-control-pass' });
  }
  receipt.configUnchanged = await fs.readFile(configPath, 'utf8') === config;
  receipt.sourceClean = git('status', '--porcelain', '--untracked-files=no') === '';
  assert(receipt.configUnchanged && receipt.sourceClean);
  await fs.rm(scratch, { recursive: true });
  receipt.cleanup = true;
  receipt.complete = true;
} catch (error) { failure = error; receipt.error = String(error.stack ?? error); receipt.retainedScratch = scratch; }
await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
if (failure) throw failure;
