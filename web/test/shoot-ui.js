// Screenshots of every screen with the fake Bluetooth rig, and a walk through the mode flows.
// usage: node shoot-ui.js <rootdir with index.html + app.js> <outdir> [scale] [dark|light] [width] [height]
// Prints PAGEERROR lines for any page error, and CHECK lines for the flow checks. Exits 1 if either went wrong.
const { chromium } = require('playwright');
const path = require('path');
const [,, root, out, scale, look, w, h] = process.argv;
const W = Number(w || 390), H = Number(h || 844);
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`CHECK ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
(async () => {
  const b = await chromium.launch();
  const mk = async (bt, age = true, store = {}) => {
    const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: Number(scale || 1), reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', e => { bad++; console.log('PAGEERROR', e.message); });
    if (bt) await page.addInitScript({ path: path.join(__dirname, 'fakebt.js') });
    const seed = { ...(age ? { age21: 'yes', fsTip: 'done' } : {}), ...(look ? { look } : {}), ...store };
    await page.addInitScript((kv) => { try { for (const k in kv) if (localStorage.getItem('torchless.' + k) === null) localStorage.setItem('torchless.' + k, kv[k]); } catch {} }, seed);
    await page.goto('file://' + path.resolve(root) + '/index.html');
    await page.waitForTimeout(700);
    return page;
  };
  const shot = (p, n, full = false) => p.screenshot({ path: `${out}/${n}.png`, fullPage: full });
  const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
  const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
  const bottom = (p, sel) => p.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().bottom), sel);

  // Age gate
  let p = await mk(true, false); await shot(p, '01-age');
  await p.click('#ageYes'); await p.waitForTimeout(300);
  check('age gate closes on I\'M 21', !(await vis(p, '#age')) && await vis(p, '#linkScreen'));

  // Front page, with and without Bluetooth
  p = await mk(true); await shot(p, '02-front');
  check('front: three choices above the fold', (await bottom(p, '#linkJarsBig')) <= H, `JARS card bottom ${await bottom(p, '#linkJarsBig')} of ${H}`);
  check('front: legal line on screen without scrolling', (await bottom(p, '.legal')) <= H, `legal bottom ${await bottom(p, '.legal')} of ${H}`);
  check('front: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  p = await mk(false); await shot(p, '03-front-nobt');
  check('no Bluetooth: OPEN IN BLUEFY shown, LINK IT hidden', await vis(p, '#openBluefy') && !(await vis(p, '#linkIt')) && !(await vis(p, '#linkAll')));
  check('no Bluetooth: choices above the fold', (await bottom(p, '#linkJarsBig')) <= H, `JARS card bottom ${await bottom(p, '#linkJarsBig')} of ${H}`);

  // TORCH from the front page, switch back, reload with the saved mode
  p = await mk(true);
  await p.click('#modeTorch'); await p.waitForTimeout(900); await shot(p, '10-torch');
  check('TORCH: torch panel showing', await vis(p, '#torchPanel') && !(await vis(p, '#linkScreen')));
  check('TORCH: header says TORCH MODE, battery hidden', (await text(p, '#linkTag')) === 'TORCH MODE' && !(await vis(p, '#batBox')));
  check('TORCH: tab bar is TORCH, JARS, MODE', await p.evaluate(() => [...document.querySelectorAll('nav.tabs button')].filter(x => x.getBoundingClientRect().width > 0).map(x => x.textContent.trim()).join(',')) === 'TORCH,JARS,MODE');
  check('TORCH: mode saved', await p.evaluate(() => localStorage.getItem('torchless.mode')) === 'torch');
  await p.click('nav [data-tab=jars]'); await p.waitForTimeout(500); await shot(p, '11-torch-jars');
  check('TORCH: jars tab opens', await vis(p, '#jarsPanel'));
  await p.reload(); await p.waitForTimeout(900); await shot(p, '12-torch-reload');
  check('reload with saved torch mode: straight to the Torch tab', await vis(p, '#torchPanel') && !(await vis(p, '#linkScreen')));
  await p.click('#tabMode'); await p.waitForTimeout(500); await shot(p, '13-switched-back');
  check('SWITCH MODE: back on the front page, mode saved as rig', await vis(p, '#linkScreen') && await p.evaluate(() => localStorage.getItem('torchless.mode')) === 'rig');

  // JARS from the front page, and back with MODES
  await p.click('#linkJarsBig'); await p.waitForTimeout(900); await shot(p, '14-front-jars');
  check('JARS from front: jars tab, rig tab bar, MODES button', await vis(p, '#jarsPanel') && await vis(p, 'nav [data-tab=home]') && await vis(p, '#modeBtn'));
  await p.click('#modeBtn'); await p.waitForTimeout(400);
  check('MODES: back on the front page', await vis(p, '#linkScreen'));
  await p.click('#lookAround'); await p.waitForTimeout(500); await shot(p, '15-look-around');
  check('LOOK AROUND FIRST: Home without a rig', await vis(p, '#faceCard') && (await text(p, '#linkTag')) === 'NOT LINKED');
  await p.click('nav [data-tab=rig]'); await p.waitForTimeout(400); await shot(p, '16-rig-unlinked');
  await p.click('.findRig'); await p.waitForTimeout(400);
  check('FIND YOUR RIG: back on the front page', await vis(p, '#linkScreen'));
  await p.click('#linkLog'); await p.waitForTimeout(400);
  check('LOG: Rig tab', await vis(p, '#rigPanel'));

  // E-RIG: link, heat, cut, every tab
  p = await mk(true);
  await p.click('#linkIt'); await p.waitForTimeout(2500); await shot(p, '04-home-idle'); await shot(p, '04-home-idle-full', true);
  check('LINK IT: Home, linked', await vis(p, '#faceCard') && /LINKED/.test(await text(p, '#linkTag')) && !(await vis(p, '#modeBtn')));
  await p.click('#editBtn'); await p.waitForTimeout(500); await shot(p, '09-editor');
  await p.click('#edCancel'); await p.waitForTimeout(400);
  check('preset editor closes', !(await vis(p, '#editor')));
  await p.click('#heat'); await p.waitForTimeout(3500); await shot(p, '05-home-heating'); await shot(p, '05-home-heating-full', true);
  check('HEAT IT: CUT IT showing', await vis(p, '#cut') && !(await vis(p, '#heat')));
  await p.click('#cut'); await p.waitForTimeout(1200);
  check('CUT IT: HEAT IT back', await vis(p, '#heat') && !(await vis(p, '#cut')));
  await p.click('nav [data-tab=jars]'); await p.waitForTimeout(500); await shot(p, '06-jars', true);
  await p.click('nav [data-tab=lights]'); await p.waitForTimeout(500); await shot(p, '07-lights'); await shot(p, '07-lights-full', true);
  await p.click('#showRow'); await p.waitForTimeout(500); await shot(p, '07b-light-show');
  await p.click('.page .textBtn'); await p.waitForTimeout(400);
  check('light show page closes', !(await vis(p, '.page')));
  await p.click('nav [data-tab=rig]'); await p.waitForTimeout(500); await shot(p, '08-rig', true);
  await p.click('.toolRow'); await p.waitForTimeout(600); await shot(p, '08b-look', true);
  await p.click('.page .textBtn'); await p.waitForTimeout(400);
  check('Look page closes', !(await vis(p, '.page')));
  await p.click('nav [data-tab=home]'); await p.waitForTimeout(400);
  check('back on Home', await vis(p, '#heat'));
  await b.close();
  console.log(bad ? `DONE with ${bad} problem(s)` : 'DONE clean');
  process.exit(bad ? 1 : 0);
})();
