const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript({ path: '/tmp/claude-0/pagecheck/fakebt.js' });
  await page.goto('file:///tmp/claude-0/pw/public/index.html');
  const st = () => page.evaluate(() => ({ conn: document.getElementById('conn').textContent, state: document.getElementById('state').textContent,
    temp: document.getElementById('temp').textContent, heat: !document.getElementById('heat').disabled, p1: document.getElementById('p1').textContent, rig: window.__rig.log.slice() }));
  await page.click('#connect');
  await page.waitForTimeout(2500);
  console.log('after connect', JSON.stringify(await st()));
  await page.click('#heat');
  await page.waitForTimeout(3000);
  const s1 = await st(); console.log('after HEAT IT', s1.state, s1.temp);
  await page.screenshot({ path: '/tmp/claude-0/pagecheck/heating.png', fullPage: true });
  await page.click('#cut');
  await page.waitForTimeout(1500);
  const s2 = await st(); console.log('after CUT IT', s2.state, 'rig events', s2.rig.filter(x => !x.startsWith('RX')).join(' | '));
  console.log('rig frames', s2.rig.filter(x => x.startsWith('RX')).length);
  console.log('page errors', JSON.stringify(errors));
  await b.close();
})();
