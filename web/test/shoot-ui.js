const { chromium } = require('playwright');
const [,, root, out, scale] = process.argv;
(async () => {
  const b = await chromium.launch();
  const mk = async (bt, age=true) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: Number(scale||1), reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('PAGEERROR', e.message));
    if (bt) await page.addInitScript({ path: '/home/claude/torchless/web/test/fakebt.js' });
    if (age) await page.addInitScript(() => { try { localStorage.setItem('torchless.age21','yes'); localStorage.setItem('torchless.fsTip','done'); } catch {} });
    await page.goto('file://' + root + '/index.html');
    await page.waitForTimeout(700);
    return page;
  };
  const shot = (p, n, full=false) => p.screenshot({ path: `${out}/${n}.png`, fullPage: full });
  let p = await mk(true, false); await shot(p, '01-age');
  p = await mk(true); await shot(p, '02-link');
  p = await mk(false); await shot(p, '03-link-nobt', true);
  p = await mk(true);
  await p.click('#linkIt'); await p.waitForTimeout(2500); await shot(p, '04-home-idle', true);
  await p.click('#heat'); await p.waitForTimeout(3500); await shot(p, '05-home-heating', true);
  await p.click('#cut'); await p.waitForTimeout(1200);
  await p.click('[data-tab=jars]'); await p.waitForTimeout(500); await shot(p, '06-jars', true);
  await p.click('nav [data-tab=lights]'); await p.waitForTimeout(500); await shot(p, '07-lights', true);
  await p.click('[data-tab=rig]'); await p.waitForTimeout(500); await shot(p, '08-rig', true);
  await b.close();
})();
