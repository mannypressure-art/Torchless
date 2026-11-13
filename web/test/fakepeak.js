// A fake navigator.bluetooth with a tiny Puffco Peak (Lorax) behind it, for a headless check of the Peak test page.
// Accepts any login token (the bench checks the token maths). Our guess at the rig, not a recording of one.
(() => {
  const peak = { state: 5, temp: 22, elapsed: 0, total: 0, active: 1, battery: 77, log: [],
    profiles: [["Shatter", 232, 30], ["Live Resin", 260, 20], ["Rosin", 288, 30], ["Hot", 316, 20]] };
  window.__peak = peak;
  const f32 = x => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return Array.from(b); };
  const str = s => Array.from(new TextEncoder().encode(s));
  setInterval(() => {
    const p = peak.profiles[peak.active];
    if (peak.state === 7) { peak.temp = Math.min(p[1], peak.temp + 20); if (peak.temp >= p[1]) { peak.state = 8; peak.elapsed = 0; peak.total = p[2]; } }
    else if (peak.state === 8) { peak.elapsed += 0.5; if (peak.elapsed >= peak.total) peak.state = 5; }
    else peak.temp = Math.max(22, peak.temp - 4);
  }, 500);
  let replyCb = null, connected = false;
  const read = path => {
    const p = peak.profiles[peak.active];
    const m = path.match(/^\/u\/app\/hc\/(\d)\/(name|temp|time)$/);
    if (m) { const q = peak.profiles[+m[1]]; return m[2] === 'name' ? str(q[0]) : f32(m[2] === 'temp' ? q[1] : q[2]); }
    return ({ '/p/app/stat/id': [peak.state], '/p/app/stat/elap': f32(peak.elapsed), '/p/app/stat/tott': f32(peak.total),
      '/p/app/htr/temp': f32(peak.temp), '/p/app/hcs': [peak.active], '/p/app/thc/temp': f32(p[1]), '/p/app/thc/time': f32(p[2]),
      '/p/bat/soc': f32(peak.battery), '/p/bat/chg/stat': [0], '/p/htr/chmt': [3], '/p/app/odom/0/nc': f32(1234),
      '/u/sys/name': str('Peak Pro 02743'), '/p/sys/hw/ser': str('PP02743'), '/p/sys/fw/ver': str('AW-1d90ae') })[path] ?? null;
  };
  const reply = { uuid: '8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c', properties: { notify: true }, value: null,
    addEventListener(_, cb) { replyCb = cb; }, async startNotifications() {} };
  const answer = (seq, status, payload = []) => setTimeout(() => {
    if (!connected || !replyCb) return;
    reply.value = new DataView(new Uint8Array([seq & 255, seq >> 8, status, ...payload]).buffer); replyCb({ target: reply });
  }, 20);
  const cmd = { uuid: '60133d5c-5727-4f2c-9697-d842c5292a3c', properties: { write: true, writeWithoutResponse: true },
    async writeValueWithoutResponse(d) {
      const b = Array.from(d), seq = b[0] | (b[1] << 8), op = b[2], body = b.slice(3);
      if (op === 0) return answer(seq, 0, Array.from({ length: 16 }, (_, i) => i * 9));
      if (op === 1) return answer(seq, 0);
      if (op === 0x10) { const path = new TextDecoder().decode(new Uint8Array(body.slice(4))); const v = read(path); return answer(seq, v ? 0 : 2, v ?? []); }
      if (op === 0x11) {
        const rest = body.slice(3), z = rest.indexOf(0), path = new TextDecoder().decode(new Uint8Array(rest.slice(0, z))), v = rest[z + 1];
        peak.log.push(`${path}=${v}`);
        if (path === '/p/app/mc') { if (v === 7 && peak.state === 5) peak.state = 7; if (v === 8 && (peak.state === 7 || peak.state === 8)) peak.state = 5; if (v === 9 && peak.state === 8) peak.total += 15; }
        if (path === '/p/app/hcs' && peak.state === 5) peak.active = v;
        return answer(seq, 0);
      }
      answer(seq, 1);
    } };
  const event = { uuid: '43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8', properties: { notify: true }, addEventListener() {}, async startNotifications() {} };
  const version = { uuid: '05434bca-cc7f-4ef6-bbb3-b1c520b9800c', properties: { read: true }, async readValue() { return new DataView(new Uint8Array([3, 0]).buffer); } };
  const svc = { uuid: 'e276967f-ea8a-478a-a92e-d78f5dd15dd5', async getCharacteristic(u) { return [version, cmd, reply, event].find(c => c.uuid === u); } };
  const listeners = [];
  const device = { id: 'fake-peak', name: 'Peak Pro 02743', addEventListener(ev, cb) { if (ev === 'gattserverdisconnected') listeners.push(cb); },
    gatt: { get connected() { return connected; }, async connect() { connected = true; return device.gatt; },
      disconnect() { connected = false; listeners.forEach(f => f()); },
      async getPrimaryService(u) { if (u === svc.uuid) return svc; throw new Error('NotFoundError'); }, async getPrimaryServices() { return [svc]; } } };
  window.__peakDevice = device;
  navigator.bluetooth = { async getAvailability() { return true; }, addEventListener() {},
    async requestDevice(o) { window.__requestOptions = o; return device; } };
})();
