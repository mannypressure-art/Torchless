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
const defsAt = index.indexOf('<svg width="0"');
const defs = index.slice(defsAt, index.indexOf('</svg>', defsAt) + 6);
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
    ok(await p.locator('.tm-keys .key').first().innerText() === '25MM QUARTZ\n5/7', `${theme}: first-version setups still load (one torch time)`);
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
    ok(await status(p) === 'CAP IT', `${theme}: CAP IT under DAB IT`);
    ok(await p.locator('.tm-next').isVisible(), `${theme}: next-time row shows at DAB IT`);
    ok(await p.evaluate(() => T.torch.running) === false, `${theme}: not running at DAB IT`);
    await p.waitForTimeout(1500);
    await shot(p, `${theme}-4b-dabit`, true);
    const dabs = await p.evaluate(() => T.store.jar('jar1').dabs);
    ok(dabs.length === 1 && dabs[0].medium === 'torch' && dabs[0].profile === 'Torch' && dabs[0].unit === 'F' && dabs[0].seconds === 5 && dabs[0].cooledIn === 7
      && dabs[0].goal === undefined && dabs[0].peak === undefined && !dabs[0].asked, `${theme}: one torch dab logged ${JSON.stringify(dabs[0])}`);
    ok(await p.evaluate(() => T.watcher.prompt) === null, `${theme}: no rating pop-up before DONE`);
    await p.locator('.tm-nextKey', { hasText: 'TOO HOT' }).click();
    ok(await p.locator('.tm-next .tm-say').innerText() === 'Next time: 17 s cool-down (was 7 s).', `${theme}: TOO HOT says what changed`);
    ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cool) === 17, `${theme}: TOO HOT saved +10 s cool`);
    await shot(p, `${theme}-4c-nudge`, true);
    await p.locator('.tm-nextKey', { hasText: 'TOO COOL' }).click();
    ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cool) === 0, `${theme}: TOO COOL re-picks from the old value (7 - 10, held at 0)`);
    await p.locator('.tm-nextKey', { hasText: 'JUST RIGHT' }).click();
    ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cool) === 7 && (await p.locator('.tm-next .tm-say').innerText()).startsWith('Kept'), `${theme}: JUST RIGHT keeps 7 s`);
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
    await btn(p, 'DONE TORCHING').click(); await p.waitForTimeout(700);
    ok(await num(p) === 'DAB IT', 'cold start: DONE TORCHING goes straight to DAB IT');
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

  // 7. Multi-step torch: named cue between steps, step marks on the ring, coming back mid-step stays quiet
  {
    const SL = JSON.stringify([{ name: 'Slurper', style: 'hot', steps: [{ cue: 'BOTTOM', secs: 5 }, { cue: 'MIDDLE', secs: 5 }, { cue: 'BOTTOM', secs: 5 }], cool: 5 }]);
    const p = await open({ setups: SL });
    ok(await status(p) === 'READY · 3 STEPS' && await num(p) === '15', 'multi-step ready: total 15 s, 3 steps');
    ok(await p.locator('.tm-stepMark').count() === 2, 'multi-step: two step marks on the ring');
    await shot(p, 'steps-1-ready', true);
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(400);
    ok(await p.locator('.tm-top').innerText() === 'STEP 1/3 · BOTTOM', 'step 1 says BOTTOM');
    ok((await p.locator('#torchPanel .hint').innerText()) === 'NEXT: MIDDLE · 5 S', 'hint names the next step');
    await p.evaluate(() => window.__skip(4700)); await p.waitForTimeout(400);
    ok(await p.locator('.tm-top').innerText() === 'STEP 2/3 · MIDDLE', 'step 2 says MIDDLE');
    ok(await p.evaluate(() => window.__vib.some(v => JSON.stringify(v) === '[60,50,60]')), 'step change: its own vibration cue');
    ok(/^Now middle/.test(await p.locator('.tm-sr').innerText()), 'step change: spoken cue for screen readers');
    ok(await p.evaluate(() => window.__vib.every(v => JSON.stringify(v) !== '[30,60,30,60,30]')), 'heads-up held back when a step cue just went off');
    await shot(p, 'steps-2-middle', true);
    const before = await p.evaluate(() => window.__vib.length);
    await away(p, 7000); await p.waitForTimeout(300);
    ok(await p.locator('.tm-top').innerText() === 'STEP 3/3 · BOTTOM', 'away through a step change: lands on step 3');
    ok(await p.evaluate(n => window.__vib.slice(n).every(v => JSON.stringify(v) !== '[60,50,60]'), before), 'away: no late step cue');
    await p.evaluate(() => window.__skip(5000)); await p.waitForTimeout(500);
    ok(await status(p) === 'COOLING DOWN' && await p.locator('.tm-stepMark').count() === 0, 'cooling: step marks gone');
    await p.evaluate(() => window.__skip(5000)); await p.waitForTimeout(500);
    ok(await num(p) === 'DAB IT', 'multi-step reaches DAB IT');
    const d = await p.evaluate(() => T.store.jar('jar1').dabs[0]);
    ok(d.seconds === 15 && d.cooledIn === 5, `multi-step dab logs total torch ${JSON.stringify(d)}`);
    await p.context().close();
  }
  // 8. Ten-second heads-up before torch off and before the cool-down ends (a sweep, not the last-five ticks)
  {
    const W = JSON.stringify([{ name: 'Long', style: 'hot', steps: [{ cue: 'ALL OVER', secs: 14 }], cool: 15 }]);
    const p = await open({ setups: W });
    const warned = () => p.evaluate(() => window.__vib.filter(v => JSON.stringify(v) === '[30,60,30,60,30]').length);
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(300);
    ok(await warned() === 0, 'no heads-up at the start');
    await p.evaluate(() => window.__skip(4000)); await p.waitForTimeout(500);
    ok(await warned() === 1 && /^Torch off in 10 seconds/.test(await p.locator('.tm-sr').innerText()), 'heads-up 10 s before torch off');
    await shot(p, 'warn-1-torch', true);
    await p.evaluate(() => window.__skip(10000)); await p.waitForTimeout(500);
    ok(await status(p) === 'COOLING DOWN', 'into cool-down');
    ok(await warned() === 1, 'no cool-down heads-up yet');
    await p.evaluate(() => window.__skip(4500)); await p.waitForTimeout(500);
    ok(await warned() === 2 && /^Dab in 10 seconds/.test(await p.locator('.tm-sr').innerText()), 'heads-up 10 s before the cool-down ends');
    const ticks0 = await p.evaluate(() => window.__vib.filter(v => v === 10).length);
    await p.evaluate(() => window.__skip(5200)); await p.waitForTimeout(500);
    ok(await p.evaluate(() => window.__vib.filter(v => v === 10).length) > ticks0, 'last-five ticks still come after it');
    // +5s past the heads-up gives it again; coming back from away past it stays quiet
    await btn(p, '+5s').click(); await btn(p, '+5s').click();
    await p.evaluate(() => window.__skip(3400)); await p.waitForTimeout(500);
    ok(await warned() === 3, 'pushed back with +5s: heads-up again');
    await btn(p, '+5s').click();
    await away(p, 9000); await p.waitForTimeout(400);
    ok(await warned() === 3, 'away past the heads-up: no late heads-up');
    await p.context().close();
  }
  // 9. Cold start counts up, keeps the tapped time as a guide mark, and stops at the 90 s cap
  {
    const CS = JSON.stringify([{ name: 'Cold', style: 'cold', steps: [{ cue: 'ALL OVER', secs: 30 }], cool: 45 }]);
    for (const theme of ['dark', 'light']) {
      const p = await open({ setups: CS, theme });
      ok(await num(p) === '0' && await p.locator('.tm-top').innerText() === 'COUNTS UP' && await p.locator('.tm-refMark').count() === 0, `${theme} cold ready: no guide yet`);
      await btn(p, 'TORCH IT').click(); await p.waitForTimeout(2300);
      ok(await num(p) === '2' && await status(p) === 'TORCH ON', `${theme} cold: counts up`);
      ok((await p.locator('#torchPanel .hint').innerText()) === 'TORCH UNTIL IT BUBBLES, THEN TAP DONE TORCHING', `${theme} cold: tells them when to tap`);
      await btn(p, 'DONE TORCHING').click(); await p.waitForTimeout(300);
      ok(await num(p) === 'DAB IT' && await status(p) === 'CAP IT', `${theme} cold: DONE TORCHING -> DAB IT, CAP IT`);
      ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cold) === 2, `${theme} cold: tapped time saved as the guide`);
      const d = await p.evaluate(() => T.store.jar('jar1').dabs[0]);
      ok(d.seconds === 2 && d.cooledIn === undefined, `${theme} cold: logs seconds run ${JSON.stringify(d)}`);
      await btn(p, 'DONE').click(); await p.evaluate(() => T.watcher.close()); await p.waitForTimeout(300);
      ok(await num(p) === '2' && await p.locator('.tm-top').innerText() === 'LAST TIME' && await p.locator('.tm-refMark').count() === 1, `${theme} cold ready: guide mark at last time`);
      await shot(p, `${theme}-cold-ready-guide`, true);
      await btn(p, 'TORCH IT').click(); await p.waitForTimeout(1200);
      ok(await p.locator('.tm-top').innerText() === 'LAST TIME 2 S', `${theme} cold: shows the guide while counting`);
      await p.waitForTimeout(2000);
      ok(await p.locator('.tm-top').innerText() === 'PAST LAST TIME' && await p.locator('.tm-refMark').count() === 1, `${theme} cold: says when past the guide`);
      await shot(p, `${theme}-cold-counting`, true);
      // the safety cap, live
      await p.evaluate(() => window.__skip(86500)); await p.waitForTimeout(800);
      ok(await num(p) === 'DAB IT' && (await p.locator('.notice.note').innerText()).includes('SAFETY CAP'), `${theme} cold: stops at the 90 s cap with a note`);
      ok(await p.evaluate(() => window.__vib.some(v => JSON.stringify(v) === '[200,100,200,100,200]')), `${theme} cold: cap has its own strong cue`);
      ok(await p.evaluate(() => T.store.jar('jar1').dabs[1].seconds) === 90, `${theme} cold: capped dab logs 90 s`);
      ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cold) === 2, `${theme} cold: a capped run doesn't move the guide`);
      await shot(p, `${theme}-cold-cap`, true);
      await p.locator('.tm-nextKey', { hasText: 'TOO HOT' }).click();
      ok(await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].cold) === 1, `${theme} cold: TOO HOT aims 3 s shorter (held at 1)`);
      await p.context().close();
    }
    // away past the cap
    const p = await open({ setups: CS });
    await btn(p, 'TORCH IT').click(); await p.waitForTimeout(300);
    await away(p, 100000); await p.waitForTimeout(400);
    ok(await num(p) === 'DAB IT' && /^Stopped at 90 s, 1[01] s ago\. Torch off\.$/.test(await p.locator('.notice.note p').innerText()), 'cold away past the cap: says when it stopped');
    await p.context().close();
  }
  // 10. New setup from a starting point; steps can be added, renamed and removed
  for (const theme of ['dark', 'light']) {
    const p = await open({ fast: false, theme });
    await p.locator('.tm-keys .tm-add').click(); await p.waitForTimeout(200);
    ok(await p.locator('.tm-sheet', { hasText: 'STARTING POINT, TUNE IT' }).count() === 1, `${theme}: NEW shows starting points`);
    await p.locator('.tm-sheet .catKey', { hasText: 'SLURPER' }).click();
    ok(await p.locator('.tm-sheet select.tm-cue').count() === 3 && await p.locator('.tm-sheet .tm-addStep').count() === 0, `${theme}: slurper fills 3 steps, no more ADD STEP`);
    ok(await p.locator('.tm-sheet input[type=text]').inputValue() === 'SLURPER', `${theme}: template names an unnamed setup`);
    await p.locator('.tm-sheet .catKey', { hasText: 'SMALL TORCH' }).click();
    await shot(p, `${theme}-editor-template`);
    await p.locator('.tm-sheet .sheetBody').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await shot(p, `${theme}-editor-template-bottom`);
    await p.locator('.tm-sheet button', { hasText: 'SAVE' }).click();
    const s1 = await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[1]);
    ok(JSON.stringify(s1.steps.map(x => x.secs)) === '[55,40,20]' && s1.cool === 60 && s1.steps[1].cue === 'MIDDLE', `${theme}: saved slurper +15 s ${JSON.stringify(s1)}`);
    ok(await p.locator('.tm-keys .key.on').innerText() === 'SLURPER\n115/60', `${theme}: key shows total/cool`);
    await shot(p, `${theme}-steps-ready`, true);
    await p.context().close();
  }
  {
    const p = await open({ fast: false });
    await btn(p, 'EDIT').click();
    ok(await p.locator('.tm-sheet', { hasText: 'STARTING POINT' }).count() === 0, 'EDIT of a saved setup: no starting points');
    await p.locator('.tm-sheet .tm-addStep').click();
    ok(await p.locator('.tm-sheet select.tm-cue').count() === 2, '+ ADD STEP adds a second step');
    await p.locator('.tm-sheet select.tm-cue').nth(1).selectOption('TOP');
    await p.locator('.tm-sheet .tm-addStep').click();
    await p.locator('.tm-sheet button[aria-label="Remove step 3"]').click();
    const small = await p.evaluate(() => [...document.querySelectorAll('.tm-sheet button, .tm-sheet select')].filter(b => b.offsetParent).map(b => {
      const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0, 14), Math.round(r.width), Math.round(r.height)]; }).filter(x => x[2] < 44 || x[1] < 44));
    ok(small.length === 0, `editor with steps: targets at least 44px ${JSON.stringify(small)}`);
    await p.waitForTimeout(500); await shot(p, 'editor-two-steps');
    await p.locator('.tm-sheet button', { hasText: 'SAVE' }).click();
    const s0 = await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0]);
    ok(JSON.stringify(s0.steps) === '[{"cue":"BOTTOM","secs":30},{"cue":"TOP","secs":20}]', `edited steps saved ${JSON.stringify(s0.steps)}`);
    await btn(p, 'COLD START').click();
    await btn(p, 'EDIT').click();
    ok(await p.locator('.tm-sheet .tm-addStep').count() === 0 && await p.locator('.tm-sheet select').count() === 0, 'cold editor: no steps');
    await p.waitForTimeout(500); await shot(p, 'editor-cold');
    await p.context().close();
  }
  {
    // next-time row: targets and space from DONE at 360 px
    const p = await open({ width: 360 });
    await btn(p, 'TORCH IT').click();
    await p.waitForFunction(() => document.querySelector('.tm-num').textContent === 'DAB IT', null, { timeout: 15000 });
    const gap = await p.evaluate(() => document.querySelector('.tm-next').getBoundingClientRect().top - [...document.querySelectorAll('#torchPanel .bigBtn')].find(b => b.offsetParent).getBoundingClientRect().bottom);
    const keys = await p.evaluate(() => [...document.querySelectorAll('.tm-nextKey')].map(b => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]));
    ok(gap >= 30 && keys.every(([w, hh]) => w >= 44 && hh >= 44), `360px: next-time keys ${JSON.stringify(keys)} sit ${Math.round(gap)} px below DONE`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '360px dab: no horizontal scroll');
    await shot(p, 'w360-dabit', true);
    await p.context().close();
  }

  // 11. GAUGE: the user's own thermometer numbers, no timer; LOG DAB logs one dab and asks for the rating
  for (const theme of ['dark', 'light']) {
    const G = JSON.stringify([{ name: 'Dabrite', style: 'gauge', steps: [{ cue: 'ALL OVER', secs: 30 }], cool: 45, dabAt: 550 }]);
    const p = await open({ setups: G, theme });
    ok(await num(p) === '550°' && await p.locator('.tm-top').innerText() === 'DAB AT', `${theme} gauge: dial shows DAB AT 550°`);
    ok(await p.locator('.tm-ready .tm-say').first().innerText() === 'Watch your gauge. Dab when it reads 550°.', `${theme} gauge: says what to watch for`);
    ok(await btn(p, 'TORCH IT').count() === 0 && await btn(p, 'LOG DAB').isVisible(), `${theme} gauge: LOG DAB, no TORCH IT`);
    ok(await p.locator('.tm-arc').getAttribute('visibility') === 'hidden' && await p.locator('.tm-stepMark, .tm-refMark').count() === 0, `${theme} gauge: no countdown ring or marks`);
    await shot(p, `${theme}-gauge-ready`, true);
    await btn(p, 'LOG DAB').click(); await p.waitForTimeout(400);
    const d = await p.evaluate(() => T.store.jar('jar1').dabs[0]);
    ok(d && d.goal === 550 && d.seconds === 0 && d.unit === 'F' && d.profile === 'Torch' && d.medium === 'torch' && d.asked === true && d.cooledIn === undefined, `${theme} gauge: dab logged ${JSON.stringify(d)}`);
    ok(await p.evaluate(() => T.watcher.prompt && T.watcher.prompt.jarID) === 'jar1', `${theme} gauge: rating pop-up opens`);
    ok(await p.evaluate(() => T.torch.running) === false && !(await p.evaluate(() => T.log.includes('awake:true'))), `${theme} gauge: never keeps the screen awake`);
    await shot(p, `${theme}-gauge-rate`);
    await p.context().close();
  }
  {
    // GAUGE 550 starting point, optional TORCH TO, and an old timer setup switched to GAUGE
    const p = await open({});
    await p.locator('.tm-keys .tm-add').click(); await p.waitForTimeout(200);
    await p.locator('.tm-sheet .catKey', { hasText: 'GAUGE 550' }).click();
    ok(await p.locator('.tm-sheet input[type=text]').inputValue() === 'GAUGE 550' && await p.locator('.tm-sheet .seg button.on').innerText() === 'GAUGE', 'GAUGE 550 starting point fills the setup');
    await p.locator('.tm-sheet button[aria-label="Dab at: 10 degrees more"]').click();
    await p.locator('.tm-sheet .tm-addStep', { hasText: 'TORCH TO' }).click();
    await p.waitForTimeout(400); await shot(p, 'gauge-editor');
    await p.locator('.tm-sheet button', { hasText: 'SAVE' }).click();
    const s = await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[2]);
    ok(s.style === 'gauge' && s.dabAt === 560 && s.torchTo === 650, `GAUGE saved ${JSON.stringify(s)}`);
    ok(await p.locator('.tm-ready .tm-say').first().innerText() === 'Torch to 650°. Watch your gauge. Dab when it reads 560°.', 'TORCH TO shows on the ready line');
    ok(await p.locator('.tm-keys .key.on').innerText() === 'GAUGE 550\n560°', 'gauge key shows its dab-at number');
    await p.locator('.tm-keys .key').first().click();
    ok(await num(p) === '5' && await btn(p, 'TORCH IT').isVisible(), 'old timer setup unchanged');
    await btn(p, 'GAUGE').click();
    ok(await num(p) === '550°' && await p.evaluate(() => JSON.parse(T.prefs.get('torch.setups'))[0].steps[0].secs) === 5, 'switching an old setup to GAUGE keeps its times');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'gauge: no horizontal scroll');
    await p.context().close();
  }
  await b.close();
  ok(errors.length === 0, `no page errors (${errors.length})`);
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})();
