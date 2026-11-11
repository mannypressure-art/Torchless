// A fake navigator.bluetooth with a tiny rig behind it, for a headless check of the test page.
(() => {
  const rig = { preset: 1, light: 3, session: 0, remaining: 0, temp: 80, bright: 50, extend: 0,
    temps: [480,450,500,520,550,600], holds: [30,12,30,10,45,60], log: [] };
  window.__rig = rig;
  let notify = null, connected = false;
  const dv = a => new DataView(new Uint8Array(a).buffer);
  const push = a => { if (notify && connected) { fec2.value = dv(a); notify({ target: fec2 }); } };
  let countdownAt = 0, total = 0;
  setInterval(() => {
    if (rig.session) {
      const now = Date.now() / 1000;
      if (now >= countdownAt) rig.remaining = Math.max(0, total - Math.floor(now - countdownAt));
      if (rig.remaining === 0 && now >= countdownAt) { rig.session = 0; rig.log.push('STOP timer'); }
      rig.temp = Math.min(rig.temps[rig.preset], rig.temp + 60);
    } else rig.temp = Math.max(80, rig.temp - 8);
    const t = Math.round(rig.temp);
    push([169,20,0,rig.preset,0,1,rig.light,rig.session,10,0,t>>8,t&255,15,rig.remaining,170,rig.extend,80,0,rig.bright,169]);
  }, 500);
  const fec1 = { uuid: '0000fec1-0000-1000-8000-00805f9b34fb', properties: { write: true, writeWithoutResponse: true },
    async writeValueWithoutResponse(d) {
      const b = Array.from(d); rig.log.push('RX ' + b.join(','));
      if (b[0] === 177) { for (let p = 0; p < 6; p++) { const f = rig.temps[p], c = Math.round((f-32)*5/9);
        push([163,8,p,f>>8,f&255,c>>8,c&255,163]); push([167,6,p,0,rig.holds[p],167]); push([165,5,p,161,165]); } }
      if (b[0] === 185) { rig.preset = b[3]; rig.light = b[6]; rig.bright = b[13];
        if (b[10] === 170 && !rig.session) { rig.session = 170; total = rig.holds[rig.preset]; rig.remaining = total; countdownAt = Date.now()/1000 + 2; rig.log.push('START app'); }
        else if (b[10] === 0 && rig.session) { rig.session = 0; rig.remaining = 0; rig.log.push('STOP app'); } }
    } };
  const fec2 = { uuid: '0000fec2-0000-1000-8000-00805f9b34fb', properties: { notify: true }, value: null,
    addEventListener(_e, fn) { notify = fn; }, async startNotifications() {}, async stopNotifications() {} };
  const fee7 = { uuid: '0000fee7-0000-1000-8000-00805f9b34fb', async getCharacteristics() { return [fec1, fec2]; } };
  const listeners = [];
  const device = { id: 'fake-rig', name: 'Presh', addEventListener(e, fn) { listeners.push(fn); },
    gatt: { get connected() { return connected; }, async connect() { connected = true; return this; },
      disconnect() { connected = false; setTimeout(() => listeners.forEach(f => f()), 0); },
      async getPrimaryServices() { return [fee7]; } } };
  window.__dropLink = () => { connected = false; listeners.forEach(f => f()); };
  navigator.bluetooth = { async requestDevice() { return device; }, async getAvailability() { return true; }, addEventListener() {} };
})();
