import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const source = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
const requireUi = createRequire(path.join(source, 'ui/package.json'));
const { chromium } = requireUi('playwright');
await fs.mkdir(artifacts, { recursive: true });
const home = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'emoji-ime-'));
const workspace = path.join(home, 'workspace');
await fs.mkdir(workspace);
const config = path.join(home, 'openclaw.json');
const port = 19449;
await fs.writeFile(config, JSON.stringify({
  gateway: {
    mode: 'local',
    auth: { mode: 'none' },
    controlUi: { dangerouslyDisableDeviceAuth: true },
  },
  agents: { list: [{ id: 'main', default: true, name: 'Emoji IME Proof', workspace,
    identity: { name: 'Emoji IME Proof', emoji: '🦞' } }] },
}));
const log = await fs.open(path.join(artifacts, 'gateway.log'), 'w');
const gateway = spawn(process.execPath, ['scripts/run-node.mjs', 'gateway', 'run',
  '--allow-unconfigured', '--bind', 'loopback', '--port', String(port), '--auth', 'none'], {
  cwd: source,
  env: { ...process.env, HOME: home, OPENCLAW_STATE_DIR: path.join(home, 'state'),
    OPENCLAW_CONFIG_PATH: config, OPENCLAW_SKIP_CHANNELS: '1' },
  stdio: ['ignore', log.fd, log.fd],
});
const exited = new Promise((resolve) => gateway.once('exit', (code, signal) => resolve({ code, signal })));
let browser;
const receipt = { source: process.env.SOURCE_SHA, node: process.version, scenes: [], errors: [] };
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited during setup: ${gateway.exitCode}`);
    try {
      const r = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { ready = true; break; }
    } catch { /* Task-owned process is still starting. */ }
    await delay(1000);
  }
  assert(ready, 'Gateway did not serve the built UI; setup failure, not product RED');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => receipt.errors.push(e.message));
  await page.goto(`${base}/agents`);
  const trigger = page.locator('.agent-emoji-picker__trigger').first();
  await trigger.waitFor({ state: 'visible', timeout: 60000 });
  assert(await trigger.isEnabled(), 'Actual agent emoji picker is unavailable; setup failure');
  const picker = page.locator('openclaw-agent-emoji-picker').first();
  const search = picker.locator('.emoji-search-panel__search');
  const popover = picker.locator('.agent-emoji-picker__popover');
  await page.evaluate(() => {
    window.imeReceipt = [];
    for (const type of ['keydown', 'keyup', 'compositionstart', 'compositionend', 'input']) {
      document.addEventListener(type, (event) => {
        if (!event.target?.matches?.('.emoji-search-panel__search')) return;
        window.imeReceipt.push({ type, trusted: event.isTrusted, key: event.key,
          keyCode: event.keyCode, composing: event.isComposing, timestamp: event.timeStamp,
          value: event.target.value });
      }, true);
    }
  });
  const cdp = await context.newCDPSession(page);
  const open = async (query) => {
    if (await popover.evaluate((el) => el.matches(':popover-open'))) await page.keyboard.press('Escape');
    await trigger.click();
    await search.waitFor({ state: 'visible' });
    await search.fill(query);
    await page.waitForFunction(() => document.activeElement?.matches('.emoji-search-panel__search'));
  };
  const snapshot = async (name) => {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    return { name, open: await popover.evaluate((el) => el.matches(':popover-open')),
      field: await page.locator('.agent-identity-editor__emoji input').first().inputValue(),
      events: await page.evaluate(() => window.imeReceipt.splice(0)) };
  };
  // Positive control: real Enter selects the first matching emoji and closes the picker.
  await open('banana');
  await page.keyboard.press('Enter');
  receipt.scenes.push(await snapshot('plain-enter'));
  assert.equal(receipt.scenes.at(-1).open, false);
  assert.equal(receipt.scenes.at(-1).field, '🍌');
  // Native browser event; record flags rather than assume it reaches the fallback.
  await open('rock');
  await cdp.send('Input.imeSetComposition', { text: 'et', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  receipt.scenes.push(await snapshot('native-229'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send('Input.insertText', { text: 'et' });
  // Existing WebKit contract: the committing Enter may follow compositionend.
  await open('rock');
  await cdp.send('Input.imeSetComposition', { text: 'et', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: 'et' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  receipt.scenes.push(await snapshot('native-commit-enter'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  // Pointer selection remains independent of the keyboard fallback.
  await open('banana');
  await picker.getByRole('button', { name: 'banana', exact: true }).click();
  receipt.scenes.push(await snapshot('pointer-control'));
  assert.equal(receipt.scenes.at(-1).open, false);
  assert.equal(receipt.scenes.at(-1).field, '🍌');
  receipt.native229 = receipt.scenes.find((s) => s.name === 'native-229');
  receipt.nativeCommit = receipt.scenes.find((s) => s.name === 'native-commit-enter');
  const fallback229 = receipt.native229.events.some((e) => e.type === 'keydown' && e.trusted &&
    e.key === 'Enter' && e.keyCode === 229 && e.composing === false);
  const end = receipt.nativeCommit.events.findLast((e) => e.type === 'compositionend');
  const enter = receipt.nativeCommit.events.findLast((e) => e.type === 'keydown' && e.key === 'Enter');
  const fallbackCommit = Boolean(end && enter && end.trusted && enter.trusted &&
    !enter.composing && Math.abs(enter.timestamp - end.timestamp) < 100);
  receipt.fallback229 = fallback229;
  receipt.fallbackCommit = fallbackCommit;
  receipt.reproduced = (fallback229 && !receipt.native229.open) ||
    (fallbackCommit && !receipt.nativeCommit.open);
  await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
  assert(receipt.reproduced, 'No native fallback defect reproduced; do not accept candidate');
  receipt.status = 'REPRODUCED';
} catch (error) {
  receipt.status = 'UNCONFIRMED';
  receipt.failure = error.stack;
  throw error;
} finally {
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser?.close();
  gateway.kill('SIGTERM');
  if (await Promise.race([exited, delay(10000, null)]) === null) {
    gateway.kill('SIGKILL');
    await exited;
  }
  await log.close();
}
