// Checks for transition.ts, in real time, in headless Chromium at 390x844.
// node test/transition/run.js        (NODE_PATH must reach playwright; ffmpeg is used for the clip test if present)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const here = __dirname;
const url = 'file://' + path.join(here, 'harness.html');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };
const state = page => page.evaluate(() => ({ ...window.__tx.state, overlays: document.querySelectorAll('.tx-overlay').length }));

async function open(b, opts = {}, query = '') {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + query);
  // note every element the transition ever puts in its overlay
  await page.evaluate(() => {
    window.__seen = [];
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.className) window.__seen.push(String(n.className)); })
      .observe(document.body, { childList: true, subtree: true });
  });
  return { ctx, page, errors };
}

(async () => {
  execFileSync('npx', ['esbuild', path.join(here, 'harness.ts'), '--bundle', '--format=iife', '--target=safari15,chrome100',
    '--outfile=' + path.join(here, 'harness.js'), '--log-level=warning'], { cwd: path.join(here, '..', '..'), stdio: 'inherit' });
  const b = await chromium.launch();

  // 1. each kind, onto a dark and a bright page
  for (const to of ['dark', 'light']) for (const kind of ['rig', 'torch', 'jars']) {
    const { ctx, page, errors } = await open(b, {}, '?to=' + to);
    await page.click(`.card[data-kind="${kind}"]`);
    await page.waitForTimeout(250);
    const mid = await page.evaluate(() => {
      const o = document.querySelector('.tx-overlay'), top = document.elementFromPoint(195, 400);
      return { overlay: !!o, canvas: !!document.querySelector('.tx-canvas'), blocked: !!o && o.contains(top), z: o && getComputedStyle(o).zIndex };
    });
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page);
    const dur = Number(s.log.find(l => l.startsWith('done')).split(' ')[2]), swapAt = Number(s.log[0].split(' ')[2]);
    check(`${kind} -> ${to}: swap once, covered, overlay gone`,
      s.swaps === 1 && s.overlays === 0 && s.cover[0] === 255 && mid.overlay && mid.canvas && mid.blocked && errors.length === 0 && dur >= 900 && dur <= 1450,
      `swap at ${swapAt} ms, total ${dur} ms, lowest canvas alpha at swap ${s.cover[0]}, taps blocked ${mid.blocked}, styles ${await page.evaluate(() => document.querySelectorAll('style#tx-style').length)}, errors ${errors.length}`);
    await ctx.close();
  }

  // 2. reduced motion: a 180 ms fade through the page background, no canvas
  {
    const { ctx, page, errors } = await open(b, { reducedMotion: 'reduce' }, '?to=light');
    await page.click('.card[data-kind="torch"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page), seen = await page.evaluate(() => window.__seen);
    const dur = Number(s.log[1].split(' ')[2]);
    check('reduced motion: fade only', s.swaps === 1 && s.overlays === 0 && !seen.some(c => /canvas|video/.test(c)) && seen.some(c => /tx-fade/.test(c)) && dur >= 150 && dur < 320 && !errors.length,
      `total ${dur} ms, at swap: ${s.cover[0]}, elements made: ${seen.join(', ')}`);
    await ctx.close();
  }

  // 3. a second call while the first plays
  {
    const { ctx, page, errors } = await open(b);
    const r = await page.evaluate(async () => {
      const tx = window.__tx, out = {};
      const first = tx.play('torch', document.querySelector('.card[data-kind="torch"]'));
      await new Promise(r => setTimeout(r, 200));
      out.beforeSecond = { swaps: tx.state.swaps, resolved: tx.state.resolved };
      const second = tx.play('rig', document.querySelector('.card[data-kind="rig"]'));
      out.rightAfter = { swaps: tx.state.swaps, overlays: document.querySelectorAll('.tx-overlay').length };
      await first;
      out.firstDone = { swaps: tx.state.swaps, resolved: tx.state.resolved, overlays: document.querySelectorAll('.tx-overlay').length };
      await second;
      out.end = { swaps: tx.state.swaps, resolved: tx.state.resolved, overlays: document.querySelectorAll('.tx-overlay').length, log: tx.state.log };
      return out;
    });
    check('double call: first finishes at once (its swap runs), second plays in full',
      r.beforeSecond.swaps === 0 && r.rightAfter.swaps === 1 && r.rightAfter.overlays === 1 && r.firstDone.overlays === 1 && r.firstDone.swaps === 1 &&
      r.end.swaps === 2 && r.end.resolved === 2 && r.end.overlays === 0 && !errors.length, r.end.log.join(' | '));
    await ctx.close();
  }

  // 4. clip slot: a missing file falls back to the drawn scene
  {
    const { ctx, page, errors } = await open(b);
    await page.evaluate(() => { window.__tx.CLIPS.torch = 'no-such-clip.mp4'; });
    await page.click('.card[data-kind="torch"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page), seen = await page.evaluate(() => window.__seen);
    const dur = Number(s.log[1].split(' ')[2]);
    check('clip missing: falls back to the canvas', s.swaps === 1 && s.overlays === 0 && s.cover[0] === 255 && seen.some(c => /tx-video/.test(c)) && seen.some(c => /tx-canvas/.test(c)) && dur < 1800 && !errors.length,
      `total ${dur} ms, elements made: ${seen.join(', ')}`);
    await ctx.close();
  }

  // 5. clip slot: a real clip plays, swaps at 55%, and goes (VP9 WebM here: this Chromium build has no H.264)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-clip-'));
    const clip = path.join(dir, 'clip.webm');
    let made = false;
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=1.2', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-an', clip]);
      made = true;
    } catch { console.log('SKIP  clip plays: ffmpeg could not make a test clip'); }
    if (made) {
      const { ctx, page, errors } = await open(b);
      await page.evaluate(u => { window.__tx.CLIPS.jars = u; }, 'file://' + clip);
      await page.click('.card[data-kind="jars"]');
      await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
      const s = await state(page), seen = await page.evaluate(() => window.__seen);
      const dur = Number(s.log[1].split(' ')[2]), at = parseFloat(String(s.cover[0]).split('@')[1]);
      check('clip plays: swap near 55%, no canvas, overlay gone', s.swaps === 1 && s.overlays === 0 && at >= 0.55 && at < 0.7 && !seen.some(c => /tx-canvas/.test(c)) && dur > 1000 && dur < 1900 && !errors.length,
        `total ${dur} ms, at swap: ${s.cover[0]}, elements made: ${seen.join(', ')}`);
      await ctx.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 6. swap throws: still resolves, overlay still goes
  {
    const { ctx, page } = await open(b);
    await page.evaluate(() => { window.__tx.state.throwInSwap = true; });
    await page.click('.card[data-kind="rig"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page);
    check('swap throws: resolves, overlay gone', s.swaps === 1 && s.overlays === 0, s.log.join(' | '));
    await ctx.close();
  }

  // 7. no canvas to be had: swap and resolve at once
  {
    const { ctx, page, errors } = await open(b);
    await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = () => null; });
    await page.click('.card[data-kind="jars"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page);
    check('canvas unavailable: swap and resolve at once', s.swaps === 1 && s.overlays === 0 && Number(s.log[1].split(' ')[2]) < 100 && !errors.length, s.log.join(' | '));
    await ctx.close();
  }

  // 8. drawing throws part-way: swap, resolve, overlay gone
  {
    const { ctx, page } = await open(b);
    await page.evaluate(() => { const real = CanvasRenderingContext2D.prototype.drawImage; let n = 0;
      CanvasRenderingContext2D.prototype.drawImage = function (...a) { if (++n > 40) throw new Error('draw blew up (on purpose)'); return real.apply(this, a); }; });
    await page.click('.card[data-kind="torch"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 6000 });
    const s = await state(page);
    check('drawing throws: swap, resolve, overlay gone', s.swaps === 1 && s.overlays === 0, s.log.join(' | '));
    await ctx.close();
  }

  // 9. frames stop coming (tab stalls): the hard timeout clears it
  {
    const { ctx, page } = await open(b);
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    await page.click('.card[data-kind="rig"]');
    await page.waitForFunction(() => window.__tx.state.resolved === 1, null, { timeout: 8000, polling: 100 });
    const s = await state(page);
    check('no frames: hard timeout swaps and clears', s.swaps === 1 && s.overlays === 0, s.log.join(' | '));
    await ctx.close();
  }

  // 10. frame pacing with the CPU slowed 4x (a rough stand-in for a mid-range phone; headless, software drawn)
  for (const kind of ['rig', 'torch', 'jars']) {
    const { ctx, page } = await open(b);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const r = await page.evaluate(async kind => {
      const gaps = []; let last = 0, on = true;
      const tick = t => { if (last) gaps.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      await window.__tx.play(kind, document.querySelector(`.card[data-kind="${kind}"]`));
      on = false;
      gaps.sort((a, b) => a - b);
      return { ms: Math.round(performance.now() - t0), frames: gaps.length, median: gaps[gaps.length >> 1], p95: gaps[Math.floor(gaps.length * 0.95)], worst: gaps[gaps.length - 1] };
    }, kind);
    console.log(`INFO  ${kind} at 4x CPU slowdown: ${r.ms} ms, ${r.frames} frames, median gap ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms`);
    await ctx.close();
  }

  await b.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
