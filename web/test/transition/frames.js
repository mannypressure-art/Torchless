// Frame sequences of each transition, for looking at. Uses Playwright's fake clock so every frame is exact.
// node test/transition/frames.js [outDir] [stepMs] [kinds] [to]
//   outDir  where the PNGs go (default test/transition/out)
//   stepMs  scene time between frames (default 80)
//   kinds   comma list of rig,torch,jars (default all)
//   to      dark,light (default both)
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const here = __dirname;
const out = path.resolve(process.argv[2] || path.join(here, 'out'));
const step = Number(process.argv[3] || 80);
const kinds = (process.argv[4] || 'rig,torch,jars').split(',');
const tos = (process.argv[5] || 'dark,light').split(',');

(async () => {
  execFileSync('npx', ['esbuild', path.join(here, 'harness.ts'), '--bundle', '--format=iife', '--target=safari15,chrome100',
    '--outfile=' + path.join(here, 'harness.js'), '--log-level=warning'], { cwd: path.join(here, '..', '..'), stdio: 'inherit' });
  const b = await chromium.launch();
  for (const kind of kinds) for (const to of tos) {
    const dir = path.join(out, `${kind}-${to}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('PAGE ERROR', e.message));
    await page.clock.install();
    await page.goto('file://' + path.join(here, 'harness.html') + '?to=' + to);
    await page.clock.pauseAt(new Date(Date.now() + 2000));
    await page.click(`.card[data-kind="${kind}"]`);
    const names = [];
    for (let t = step; t <= 1600; t += step) {
      for (let k = 0; k < step; k += 20) await page.clock.runFor(20);
      const gone = await page.evaluate(() => !document.querySelector('.tx-overlay'));
      const name = String(t).padStart(4, '0') + '.png';
      await page.screenshot({ path: path.join(dir, name) });
      names.push(name);
      if (gone) break;
    }
    // contact sheet
    const sheet = await b.newPage({ viewport: { width: 8 * 199 + 4, height: Math.ceil(names.length / 8) * 426 + 4 } });
    fs.writeFileSync(path.join(dir, 'sheet.html'), `<body style="margin:4px;background:#333;display:flex;flex-wrap:wrap;gap:4px;font:11px monospace;color:#fff">` +
      names.map(n => `<div style="position:relative"><img src="${n}" style="width:195px;height:422px;display:block"><span style="position:absolute;left:2px;top:2px;background:#000a;padding:1px 3px">${parseInt(n)}</span></div>`).join('') + `</body>`);
    await sheet.goto('file://' + path.join(dir, 'sheet.html'));
    await sheet.screenshot({ path: path.join(out, `sheet-${kind}-${to}.png`) });
    await sheet.close();
    console.log(kind, to, names.length, 'frames', await page.evaluate(() => JSON.stringify(window.__tx.state.log)));
    await ctx.close();
  }
  await b.close();
})();
