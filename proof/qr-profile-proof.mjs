import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const phase = process.env.PROOF_PHASE;
assert.ok(phase === 'baseline' || phase === 'fixed');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'openclaw-qr-profile-'));
const receipt = { phase, sourceHead: process.env.SOURCE_HEAD, complete: false,
  productVerdict: 'unknown', cleanup: false, cases: [] };
const config = JSON.stringify({ gateway: { auth: { mode: 'token', token: 'synthetic-qr-proof-token' } } });
const keep = ['PATH', 'COREPACK_HOME', 'PNPM_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT'];
const safeEnv = Object.fromEntries(keep.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
const sanitize = (text) => text.replace(/(Setup code:\s*)[A-Za-z0-9_-]+/g, '$1[REDACTED]');

try {
  const sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  assert.equal(sourceHead.status, 0);
  assert.equal(sourceHead.stdout.trim(), process.env.SOURCE_HEAD);
  const cases = [
    { profile: '', label: 'default', command: ['qr'] },
    { profile: 'proof', label: 'proof', command: ['qr'] },
    ...(phase === 'fixed' ? [{ profile: 'proof', label: 'proof-legacy', command: ['clawbot', 'qr'] }] : []),
  ];
  for (const { profile, label, command } of cases) {
    const home = join(scratch, label);
    const state = join(home, profile ? `.openclaw-${profile}` : '.openclaw');
    mkdirSync(state, { recursive: true });
    const configPath = join(state, 'openclaw.json');
    writeFileSync(configPath, config);
    const args = ['--silent', 'openclaw', ...(profile ? ['--profile', profile] : []),
      ...command, '--no-ascii', '--url', 'ws://127.0.0.1:18789'];
    const result = spawnSync('pnpm', args, {
      cwd: source,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...safeEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: scratch, CI: 'true', NO_COLOR: '1' },
    });
    writeFileSync(join(output, `${label}.stdout.txt`), sanitize(result.stdout ?? ''));
    writeFileSync(join(output, `${label}.stderr.txt`), sanitize(result.stderr ?? ''));
    assert.equal(result.error?.code, undefined, `${label}: child spawn/timeout failed`);
    assert.equal(result.status, 0, `${label}: supported CLI failed`);
    const code = result.stdout.match(/^Setup code: ([A-Za-z0-9_-]+)$/m)?.[1];
    assert.ok(code, `${label}: actual setup output missing`);
    const payload = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    assert.equal(payload.url, 'ws://127.0.0.1:18789');
    assert.ok(typeof payload.bootstrapToken === 'string' && payload.bootstrapToken.length > 10);
    assert.ok(payload.expiresAtMs > Date.now());
    const prefix = profile ? `openclaw --profile ${profile}` : 'openclaw';
    const hints = [`${prefix} devices list`, `${prefix} devices approve <requestId>`];
    const found = hints.map((hint) => result.stdout.includes(hint));
    if (phase === 'baseline' && profile) {
      assert.deepEqual(found, [false, false], 'baseline does not reproduce the named-profile defect');
      assert.ok(result.stdout.includes('openclaw devices list'));
      assert.ok(result.stdout.includes('openclaw devices approve <requestId>'));
    } else {
      assert.deepEqual(found, [true, true], `${label}: approval hints lost their invocation context`);
    }
    assert.equal(readFileSync(configPath, 'utf8'), config, 'QR modified authored configuration');
    receipt.cases.push({ profile: profile || 'default', command, label, cliExit: result.status, setupGenerated: true,
      expectedHints: hints, hintsPresent: found, configUnchanged: true,
      expectedProductVerdict: phase === 'baseline' && profile ? 'fail' : 'pass',
      productVerdict: found.every(Boolean) ? 'pass' : 'fail' });
  }
  receipt.productVerdict = phase === 'baseline' ? 'fail' : 'pass';
  receipt.complete = true;
} catch (error) {
  receipt.failure = error.message;
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true });
  receipt.cleanup = true;
  writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
