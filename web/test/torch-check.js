// Builds the Torch mode harness page and drives it in headless Chromium.
//   node test/torch-check.js <outDir>
// The page takes its <style> and svg defs straight from public/index.html, so it always matches the app's look.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const web = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(web, 'test', 'torch-out'));
fs.mkdirSync(out, { recursive: true });

const index = fs.readFileSync(path.join(web, 'public', 'index.html'), 'utf8');
const head = index.slice(index.indexOf('<link rel="preconnect"'), index.indexOf('</head>'));
const defs = index.slice(index.indexOf('<svg width="0"'), index.indexOf('</svg>') + 6);
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Torch mode harness</title>
${head}</head><body>${defs}
<div class="wrap">
  <header class="head"><svg class="mark"><use href="#markSym"/></svg>
    <div><div class="brand">TORCHLESS</div><div class="linkRow"><span class="dot"></span><span class="tag" style="font-size:9.5px">TORCH MODE</span></div></div></header>
  <section id="torchPanel" style="margin-top:14px"></section>
  <div id="curJar" hidden></div><section id="jarsPanel" hidden></section>
</div>
<nav class="tabs"><button class="on">TORCH</button><button>JARS</button><button>RIG</button></nav>
<div id="sheets"></div><script src="app.js"></script></body></html>`);
execFileSync(path.join(web, 'node_modules', '.bin', 'esbuild'), [path.join(web, 'test', 'torch-harness.ts'), '--bundle', '--format=iife',
  '--target=safari15,chrome100', '--loader:.worklet=text', '--log-level=warning', '--outfile=' + path.join(out, 'app.js')], { stdio: 'inherit' });

let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
const FAST = JSON.stringify([{ name: '25mm quartz', style: 'hot', torch: 5, cool: 7, cold: 5 }, { name: 'Terp slurper', style: 'cold', torch: 40, cool: 60, cold: 5 }]);

(async () => {
  const b = await chromium.launch();
  const errors = [];
  const open = async ({ theme = 'dark', width = 390, height = 844, fast = true, jar = true, reduced = false, setups = FAST, sound = '' } = {}) => {
    const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) { errors.push(m.text()); console.log('CONSOLE', m.text()); } });
    await page.addInitScript(({ fast, setups }) => {
      // A clock that can be pushed forward, to stand in for a locked phone (page frozen, time moving on).
      const real = Date.now.bind(Date); let off = 0;
      Date.now = () => real() + off;
      window.__skip = ms => { off += ms; };
      window.__vib = []; navigator.vibrate = p => { window.__vib.push(p); return true; };
      try { if (fast && !localStorage.getItem('torchless.torch.setups')) localStorage.setItem('torchless.torch.setups', setups); } catch {}
    }, { fast, setups });
    await page.goto('file://' + out + `/index.html?theme=${theme}&jar=${jar ? 1 : 0}${sound ? '&sound=' + sound : ''}`);
    await page.waitForSelector('body[data-ready]');
    await page.waitForTimeout(400);
    return page;
  };
  const shot = (p, n, full = false) => p.screenshot({ path: `${out}/${n}.png`, fullPage: full });
  const num = p => p.locator('.tm-num').innerText();
  const status = p => p.locator('.tm-status').innerText();
  const btn = (p, t) => p.locator('#torchPanel button:visible', { hasText: t }).first();
  const away = (p, ms) => p.evaluate(ms => {
    const set = v => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    set('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    window.__skip(ms);
    set('visible'); document.dispatchEvent(new Event('visibilitychange'));
  }, ms);

  // 1. Whole hot-dab flow, both themes, with screenshots of every state
  for (const theme of ['dark', 'light']) {
    const p = await open({ theme });
    ok(await status(p) === 'READY' && await num(p) === '5', `${theme}: ready shows torch time`);
    ok(await p.evaluate(() => T.torch.running) === false, `${theme}: not running at ready`);
    await shot(p, `${theme}-1-ready`, true);
    await btn(p, 'EDIT').click(); await p.waitForTimeout(250);
    await shot(p, `${theme}-1b-editor`);
    await p.locator('.tm-sheet button', { hasText: 'Cancel' }).click();
    await btn(p, 'TORCH IT').click();
    await p.waitForTimeout(2600);
    ok(await status(p) === 'TORCH ON', `${theme}: torching says TORCH ON`);
    ok(await p.evaluate(() => T.torch.running) === true, `${theme}: running while torching`);
    await shot(p, `${theme}-2-torching`, true);
    await p.waitForTimeout(3600);
    ok(await status(p) === 'COOLING DOWN', `${theme}: cool-down starts by itself`);
    ok(await p.evaluate(() => T.torch.running) === true, `${theme}: running while cooling`);
    await shot(p, `${theme}-3-cooling`, true);
    await btn(p, '+5s').click();
    const n1 = Number(await num(p));
    ok(n1 >= 9 && n1 <= 11, `${theme}: +5s adds time (${n1})`);
    await btn(p, '−5s').click();
    await p.waitForTimeout(3300);
    await shot(p, `${theme}-3b-cooling-late`, true);
    await p.waitForFunction(() => document.querySelector('.tm-num').textContent === 'DAB IT', null, { timeout: 6000, polling: 50 });
    await p.waitForTimeout(260);
    await shot(p, `${theme}-4-dabit-burst`, true);
    ok(await num(p) === 'DAB IT', `${theme}: reaches DAB IT`);
    ok(await p.evaluate(() => T.torch.running) === false, `${theme}: not running at DAB IT`);
    await p.waitForTimeout(1500);
    await shot(p, `${theme}-4b-dabit`, true);
    const dabs = await p.evaluate(() => T.store.jar('jar1').dabs);
    ok(dabs.length === 1 && dabs[0].medium === 'torch' && dabs[0].profile === 'Torch' && dabs[0].unit === 'F' && dabs[0].seconds === 5 && dabs[0].cooledIn === 7
      && dabs[0].goal === undefined && dabs[0].peak === undefined && !dabs[0].asked, `${theme}: one torch dab logged ${JSON.stringify(dabs[0])}`);
    ok(await p.evaluate(() => T.watcher.prompt) === null, `${theme}: no rating pop-up before DONE`);
    await btn(p, 'DONE').click(); await p.waitForTimeout(400);
    ok(await p.evaluate(() => T.watcher.prompt && T.watcher.prompt.jarID) === 'jar1', `${theme}: DONE opens the rating pop-up`);
    ok(await p.evaluate(() => T.store.jar('jar1').dabs[0].asked) === true, `${theme}: dab marked asked`);
    ok(await status(p) === 'READY', `${theme}: back to ready`);
    await shot(p, `${theme}-5-rate`);
    const log = await p.evaluate(() => T.log.join(' '));
    ok(/^awake:true .*awake:false/.test(log), `${theme}: keepAwake on then off (${log})`);
    ok((await p.evaluate(() => window.__vib.length)) >= 3, `${theme}: vibration cues fired`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme}: no horizontal scroll`);
    await p.context().close();
  }

  // 2. Away longer than the torch phase: lands in cool-down with the right time left
  {
    const p = await open({});
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(500);
    await away(p, 8000);   // torch 5 s + 3.5 s of the 7 s cool-down
    await p.waitForTimeout(300);
    const n = Number(await num(p));
    ok(await status(p) === 'COOLING DOWN' && n >= 3 && n <= 4, `away 8 s from torching: cooling with ${n} s left`);
    const msg = await p.locator('.notice.note p').innerText();
    ok(/^Torch time ended [34] s ago\. Cool-down is running\.$/.test(msg), `away notice: "${msg}"`);
    await shot(p, 'away-1-cooling', true);
    await p.context().close();
  }
  // 3. Away longer than both phases: lands on DAB IT, says how long ago, logs the planned times
  {
    const p = await open({});
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(500);
    await away(p, 24000);
    await p.waitForTimeout(600);
    ok(await num(p) === 'DAB IT', 'away 24 s from torching: DAB IT');
    const msg = await p.locator('.notice.note p').innerText();
    ok(/^Cool-down ended 1[23] s ago\.$/.test(msg), `away notice: "${msg}"`);
    const d = await p.evaluate(() => T.store.jar('jar1').dabs[0]);
    ok(d.seconds === 5 && d.cooledIn === 7, `away: dab keeps planned times ${JSON.stringify(d)}`);
    ok(await p.evaluate(() => T.watcher.prompt) === null, 'away: no pop-up the moment you come back');
    await shot(p, 'away-2-dabit', true);
    await p.evaluate(() => window.__skip(15500)); await p.waitForTimeout(600);
    ok(await p.evaluate(() => !!T.watcher.prompt) && await status(p) === 'READY', 'pop-up 15 s after DAB IT, back at ready');
    await p.context().close();
  }
  // 4. STOP, TORCH OFF NOW, cold start, no jar
  {
    const p = await open({ jar: false });
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(1200);
    await btn(p, 'STOP').click(); await p.waitForTimeout(200);
    ok(await status(p) === 'READY' && await p.evaluate(() => T.torch.running) === false, 'STOP while torching: back to ready');
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(2100);
    await btn(p, 'TORCH OFF NOW').click(); await p.waitForTimeout(200);
    ok(await status(p) === 'COOLING DOWN', 'TORCH OFF NOW: cooling');
    await btn(p, 'STOP').click(); await p.waitForTimeout(200);
    ok(await status(p) === 'READY', 'STOP while cooling: back to ready');
    ok(await p.evaluate(() => T.watcher.prompt) === null, 'stopped runs log nothing and ask nothing');
    await btn(p, 'COLD START').click(); await p.waitForTimeout(200);
    await shot(p, 'cold-1-ready', true);
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(2000);
    await btn(p, 'TORCH OFF NOW').click(); await p.waitForTimeout(700);
    ok(await num(p) === 'DAB IT', 'cold start: torch off goes straight to DAB IT');
    await shot(p, 'cold-2-dabit', true);
    await btn(p, 'DONE').click(); await p.waitForTimeout(400);
    const pr = await p.evaluate(() => T.watcher.prompt);
    ok(pr && pr.jarID === null && pr.dab.medium === 'torch' && pr.dab.seconds === 2 && pr.dab.cooledIn === undefined, `no jar: pop-up with jarID null ${JSON.stringify(pr)}`);
    await shot(p, 'nojar-rate');
    await p.context().close();
  }
  // 5. Setups: add, edit, persist, limit of four
  {
    const p = await open({ fast: false });
    ok(await num(p) === '30' && await p.locator('.tm-keys .key').count() === 2, 'defaults: 30 s torch, one setup plus NEW');
    await shot(p, 'default-ready', true);
    await p.locator('.tm-keys .tm-add').click();
    await p.locator('.tm-sheet input[type=text]').fill('Opal bucket');
    await p.locator('.tm-sheet button[aria-label="Torch time: 1 second more"]').click();
    await p.locator('.tm-sheet input[type=range]').nth(1).fill('60');
    await p.locator('.tm-sheet button', { hasText: 'SAVE' }).click();
    ok(await num(p) === '31', 'new setup selected, torch 31');
    const saved = await p.evaluate(() => [T.prefs.get('torch.setups'), T.prefs.get('torch.setup')]);
    ok(saved[1] === '1' && JSON.parse(saved[0])[1].name === 'Opal bucket' && JSON.parse(saved[0])[1].cool === 60, `saved to prefs ${saved[0]}`);
    for (let i = 0; i < 2; i++) { await p.locator('.tm-keys .tm-add').click(); await p.locator('.tm-sheet button', { hasText: 'SAVE' }).click(); }
    ok(await p.locator('.tm-keys .key').count() === 4 && await p.locator('.tm-keys .tm-add').count() === 0, 'four setups, no more NEW key');
    await shot(p, 'setups-four', true);
    await p.reload(); await p.waitForSelector('body[data-ready]');
    ok(await p.locator('.tm-keys .key').count() === 4, 'setups survive a reload');
    await btn(p, 'EDIT').click();
    const small = await p.evaluate(() => [...document.querySelectorAll('#torchPanel button, .tm-sheet button')].filter(b => b.offsetParent).map(b => {
      const r = b.getBoundingClientRect(), a = getComputedStyle(b, '::after'); const extra = a.content !== 'none' ? 14 : 0;
      return [b.textContent.trim().slice(0, 14), Math.round(r.width + (extra ? 12 : 0)), Math.round(r.height + extra)]; }).filter(x => x[2] < 44 || x[1] < 44));
    ok(small.length === 0, `touch targets at least 44px ${JSON.stringify(small)}`);
    await p.context().close();
  }
  // 6. Narrow and wide phones, reduced motion, sound off
  for (const width of [360, 430]) {
    const p = await open({ width, theme: width === 360 ? 'light' : 'dark' });
    await shot(p, `w${width}-ready`, true);
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(3000);
    await shot(p, `w${width}-torching`, true);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px: no horizontal scroll`);
    await p.context().close();
  }
  {
    const p = await open({ reduced: true, sound: 'off' });
    ok((await p.locator('#torchPanel .hint').innerText()).includes('SOUND IS OFF'), 'sound off is said on the ready screen');
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(3000);
    await shot(p, 'reduced-torching', true);
    await p.waitForTimeout(6000);
    await shot(p, 'reduced-cooling', true);
    await p.waitForTimeout(4500);
    ok(await num(p) === 'DAB IT', 'reduced motion: flow still reaches DAB IT');
    await shot(p, 'reduced-dabit', true);
    await p.context().close();
  }
  await b.close();
  ok(errors.length === 0, `no page errors (${errors.length})`);
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})();
