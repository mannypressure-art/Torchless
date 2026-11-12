// Port of JarStore.swift (and the data half of JarDabs.swift): the jar library, the current jar,
// dabs logged to jars, flavors and the price readouts. Same rules and limits as the iPhone app.
// Nothing here talks to the rig. Storage is behind JarBackend: IndexedDB in the browser, memory in tests.

export interface JarDab {
  id: string;
  /** When heat went on (ISO 8601, same as the iPhone app). */
  at: string;
  /** Seconds of heat. */
  seconds: number;
  /** The goal temp at the end of the dab. */
  goal?: number;
  /** For profiles that climb or fall: the far end of the range, from the live peak. */
  goalTop?: number;
  /** Highest live temp the rig reported. */
  peak?: number;
  unit: "F" | "C";
  profile?: string;
  /** 1.0 to 10.0 in tenths. */
  rating?: number;
  note?: string;
  /** The rating pop-up was already shown for this dab. */
  asked?: boolean;
  /** Seconds from heat off until the rig read 300 F (149 C) or less. */
  cooledIn?: number;
  /** Dab size in grams (0.05 to 1). */
  grams?: number;
}

export interface Jar {
  id: string;
  strain: string;
  producer: string;
  category?: string;
  review: string;
  /** 0.0 to 10.0 in tenths. */
  rating?: number;
  /** Photo key in the backend. */
  photo?: string;
  finished: boolean;
  /** ISO 8601 dates throughout, so records match the iPhone app's jars.json. */
  added: string;
  price?: number;
  grams?: number;
  shop?: string;
  bought?: string;
  sessions?: number;
  dabs?: JarDab[];
  flavors?: string[];
  updated: string;
}

export const JarCategory = ["Live rosin", "Rosin", "Badder", "Sauce", "Diamonds", "Jam", "Live resin", "Hash", "Shatter", "Other"];
export const JarFlavor = ["Citrus", "Gas", "Fruity", "Sweet", "Earthy", "Pine", "Floral", "Funk", "Spicy", "Creamy"];
export const REVIEW_LIMIT = 500;
export const GRAM_PICKS = [0.5, 1, 2, 3.5, 7];

/** Upper-case UUIDs, like Swift's UUID().uuidString. */
export const uid = (): string => {
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (c.randomUUID) return c.randomUUID().toUpperCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const round1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// MARK: Jar helpers

export const Jars = {
  clampRating: (r: number) => round1(clamp(r, 0, 10)),
  ratingText: (r?: number | null) => (r === undefined || r === null ? "—" : r.toFixed(1)),
  money(v?: number | null): string {
    if (v === undefined || v === null) return "—";
    return v >= 100 || Math.round(v) === v ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
  },
  gramsText(g?: number | null): string {
    if (g === undefined || g === null) return "—";
    return (Math.round(g) === g ? g.toFixed(0) : g.toFixed(1)) + " g";
  },
  boughtOn: (j: Jar) => Date.parse(j.bought ?? j.added),
  sessionCount: (j: Jar) => j.sessions ?? 0,
  perGram(j: Jar): number | undefined {
    return j.price && j.grams && j.price > 0 && j.grams > 0 ? j.price / j.grams : undefined;
  },
  avgDabGrams(j: Jar): number | undefined {
    const s = (j.dabs ?? []).map(d => d.grams).filter((g): g is number => g !== undefined);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : undefined;
  },
  /** Cost of one dab: real dab sizes when logged, else price over sessions. */
  perSession(j: Jar): number | undefined {
    const pg = Jars.perGram(j), avg = Jars.avgDabGrams(j);
    if (pg !== undefined && avg !== undefined) return pg * avg;
    const n = Jars.sessionCount(j);
    return j.price && j.price > 0 && n > 0 ? j.price / n : undefined;
  },
  usedGrams: (j: Jar) => (j.dabs ?? []).reduce((a, d) => a + (d.grams ?? 0), 0),
  gramsLeft(j: Jar): number | undefined {
    const used = Jars.usedGrams(j);
    return j.grams && j.grams > 0 && used > 0 ? Math.max(j.grams - used, 0) : undefined;
  },
  lastDabGrams(j: Jar): number | undefined {
    const d = (j.dabs ?? []).filter(x => x.grams !== undefined);
    return d.length ? d[d.length - 1].grams : undefined;
  },
  matches(j: Jar, query: string): boolean {
    const words = query.toLowerCase().split(" ").filter(Boolean);
    if (!words.length) return true;
    const hay = [j.strain, j.producer, j.category ?? "", j.review].join(" ").toLowerCase();
    return words.every(w => hay.includes(w));
  },
};

// MARK: Dab helpers

export const SIZE_STOPS: { name: string; grams: number }[] = [
  { name: "SMALL", grams: 0.05 }, { name: "MEDIUM", grams: 0.1 }, { name: "LARGE", grams: 0.2 },
  { name: "XL", grams: 0.4 }, { name: "GLOB", grams: 1.0 },
];

export const Dabs = {
  clamp: (r: number) => round1(clamp(r, 1, 10)),
  clampGrams: (g: number) => Math.round(clamp(g, 0.05, 1) * 100) / 100,
  gramsAt(pos: number): number {
    const n = SIZE_STOPS.length - 1;
    const x = clamp(pos, 0, n);
    const i = Math.min(Math.floor(x), SIZE_STOPS.length - 2);
    const f = x - i;
    return Dabs.clampGrams(SIZE_STOPS[i].grams + (SIZE_STOPS[i + 1].grams - SIZE_STOPS[i].grams) * f);
  },
  positionFor(g: number): number {
    const v = Dabs.clampGrams(g);
    for (let i = 0; i < SIZE_STOPS.length - 1; i++) {
      if (v <= SIZE_STOPS[i + 1].grams) {
        const a = SIZE_STOPS[i].grams, b = SIZE_STOPS[i + 1].grams;
        return i + (v - a) / (b - a);
      }
    }
    return SIZE_STOPS.length - 1;
  },
  snap(pos: number): number { const r = Math.round(pos); return Math.abs(pos - r) < 0.15 ? r : pos; },
  sizeText(g: number): string {
    const v = Dabs.clampGrams(g);
    const name = SIZE_STOPS.find(s => Math.abs(s.grams - v) < 0.001)?.name;
    return `${v.toFixed(2)} G` + (name ? ` · ${name}` : "");
  },
  isFlat: (d: JarDab) => d.profile === undefined || d.profile === "Steady" || d.profile === "Unknown",
  goalText(d: JarDab): string {
    if (d.goal === undefined) return d.peak !== undefined ? `${d.peak}°${d.unit}` : "—";
    if (!Dabs.isFlat(d) && d.goalTop !== undefined && d.goalTop !== d.goal) return `${d.goal}–${d.goalTop}°${d.unit}`;
    return `${d.goal}°${d.unit}`;
  },
  groupKey(d: JarDab): string {
    const base = d.goal !== undefined ? `${d.goal}°${d.unit}` : "?";
    return Dabs.isFlat(d) ? base : `${base} ${(d.profile ?? "").toUpperCase()}`;
  },
  /** Flavor reminder: while the jar has no flavors, on dabs 3, 6, 10, then every 10th. */
  flavorNudge(n: number, hasFlavors: boolean): boolean {
    if (hasFlavors) return false;
    return n === 3 || n === 6 || (n >= 10 && n % 10 === 0);
  },
};

export interface DabTempRow { key: string; goal?: number; flat: boolean; avg: number; count: number }

// MARK: Storage

export interface JarBackend {
  loadList(): Promise<unknown>;
  saveList(list: Jar[]): Promise<void>;
  putPhoto(key: string, big: Blob, thumb: Blob): Promise<void>;
  getPhoto(key: string, thumb: boolean): Promise<Blob | null>;
  deletePhoto(key: string): Promise<void>;
  /** Small settings (the current jar id). */
  getPref(key: string): string | null;
  setPref(key: string, value: string | null): void;
}

export class MemoryJarBackend implements JarBackend {
  list: unknown = null;
  photos = new Map<string, { big: Blob; thumb: Blob }>();
  prefs = new Map<string, string>();
  async loadList() { return this.list === null ? null : JSON.parse(JSON.stringify(this.list)); }
  async saveList(list: Jar[]) { this.list = JSON.parse(JSON.stringify(list)); }
  async putPhoto(k: string, big: Blob, thumb: Blob) { this.photos.set(k, { big, thumb }); }
  async getPhoto(k: string, thumb: boolean) { const p = this.photos.get(k); return p ? (thumb ? p.thumb : p.big) : null; }
  async deletePhoto(k: string) { this.photos.delete(k); }
  getPref(k: string) { return this.prefs.get(k) ?? null; }
  setPref(k: string, v: string | null) { if (v === null) this.prefs.delete(k); else this.prefs.set(k, v); }
}

/** What the photo slot should do on save. */
export type PhotoChange = { kind: "keep" } | { kind: "remove" } | { kind: "replace"; big: Blob; thumb: Blob };

export interface Spend {
  month: number; year: number; all: number; pricedJars: number; avgPerGram?: number;
  /** Last 12 months, newest first: [first day of month (ms), total]. */
  byMonth: [number, number][];
}

// MARK: The store

export class JarStore {
  jars: Jar[] = [];
  currentID: string | null = null;
  problem: string | null = null;
  ready = false;
  onChange: () => void = () => {};
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly backend: JarBackend) {}

  async load(): Promise<void> {
    try {
      const raw = await this.backend.loadList();
      this.jars = Array.isArray(raw) ? (raw as Jar[]).filter(j => j && typeof j.id === "string" && typeof j.strain === "string") : [];
    } catch {
      this.jars = [];
      this.problem = "Couldn't read the saved jars on this phone.";
    }
    const cur = this.backend.getPref("currentJar");
    this.currentID = cur && this.jars.some(j => j.id === cur && !j.finished) ? cur : null;
    this.ready = true;
    this.onChange();
  }

  jar(id: string | null | undefined): Jar | undefined { return id ? this.jars.find(j => j.id === id) : undefined; }
  get current(): Jar | undefined { return this.jar(this.currentID); }

  /** Sets (or clears) the current jar. A finished or missing jar can't be current. */
  setCurrent(id: string | null): void {
    const next = id && this.jars.some(j => j.id === id && !j.finished) ? id : null;
    this.currentID = next;
    this.backend.setPref("currentJar", next);
    this.onChange();
  }

  /** Open jars first, then newest first. */
  get shelf(): Jar[] {
    return [...this.jars].sort((a, b) => (a.finished !== b.finished ? (a.finished ? 1 : -1) : Date.parse(b.added) - Date.parse(a.added)));
  }
  get openCount(): number { return this.jars.filter(j => !j.finished).length; }
  get usedCategories(): string[] {
    const used = new Set(this.jars.map(j => j.category).filter(Boolean));
    return JarCategory.filter(c => used.has(c));
  }
  get knownProducers(): string[] {
    const count = new Map<string, number>(), shown = new Map<string, string>();
    for (const j of this.jars) {
      const name = j.producer.trim();
      if (!name) continue;
      const k = name.toLowerCase();
      count.set(k, (count.get(k) ?? 0) + 1);
      if (!shown.has(k)) shown.set(k, name);
    }
    return [...count.keys()].sort((a, b) => (count.get(b)! - count.get(a)!) || a.localeCompare(b)).map(k => shown.get(k)!);
  }

  private persist(list: Jar[]): Promise<boolean> {
    const run = this.saving.then(() => this.backend.saveList(list)).then(
      () => { this.problem = null; return true; },
      () => { this.problem = "Couldn't save the jar list. The phone may be out of space."; return false; });
    this.saving = run.then(() => undefined);
    return run;
  }

  /** Adds the jar if new, else replaces the saved one with the same id. */
  async save(input: Jar, change: PhotoChange = { kind: "keep" }): Promise<boolean> {
    const jar: Jar = { ...input };
    jar.strain = jar.strain.trim();
    jar.producer = jar.producer.trim();
    if (jar.category && !JarCategory.includes(jar.category)) delete jar.category;
    if (jar.price !== undefined && !(jar.price > 0 && jar.price < 100000)) delete jar.price;
    if (jar.grams !== undefined && !(jar.grams > 0 && jar.grams <= 1000)) delete jar.grams;
    const shop = (jar.shop ?? "").trim();
    if (shop) jar.shop = shop.slice(0, 60); else delete jar.shop;
    if (jar.sessions !== undefined) { if (jar.sessions > 0) jar.sessions = Math.min(jar.sessions, 100000); else delete jar.sessions; }
    if (jar.dabs) { if (jar.dabs.length) jar.dabs = jar.dabs.slice(-2000); else delete jar.dabs; }
    if (jar.flavors) { const c = JarFlavor.filter(f => jar.flavors!.includes(f)); if (c.length) jar.flavors = c; else delete jar.flavors; }
    jar.review = jar.review.trim().slice(0, REVIEW_LIMIT);
    if (jar.rating !== undefined) jar.rating = Jars.clampRating(jar.rating);
    if (!jar.strain) return false;
    jar.updated = new Date().toISOString();

    const old = this.jar(jar.id)?.photo;
    let dropAfter: string | undefined;
    if (change.kind === "keep") { if (old) jar.photo = old; else delete jar.photo; }
    else if (change.kind === "remove") { delete jar.photo; dropAfter = old; }
    else {
      const key = `${jar.id}-${Date.now()}`;
      try { await this.backend.putPhoto(key, change.big, change.thumb); }
      catch { this.problem = "Couldn't save that photo. The phone may be out of space."; this.onChange(); return false; }
      jar.photo = key;
      dropAfter = old;
    }

    const next = [...this.jars];
    const i = next.findIndex(j => j.id === jar.id);
    if (i >= 0) next[i] = jar; else next.push(jar);
    const firstEver = this.jars.length === 0 && next.length === 1;
    this.jars = next;   // show it right away; the write follows
    const ok = await this.persist(next);
    if (!ok) {
      if (change.kind === "replace" && jar.photo) void this.backend.deletePhoto(jar.photo);
      this.onChange();
      return false;
    }
    if (dropAfter) { photoURLs.drop(dropAfter); void this.backend.deletePhoto(dropAfter); }
    if (jar.finished && this.currentID === jar.id) this.setCurrent(null);
    if (firstEver && !jar.finished) this.setCurrent(jar.id);   // the first and only jar is the current jar
    this.onChange();
    return true;
  }

  async delete(id: string): Promise<void> {
    const j = this.jar(id);
    if (!j) return;
    const next = this.jars.filter(x => x.id !== id);
    this.jars = next;
    if (!(await this.persist(next))) { this.onChange(); return; }
    if (this.currentID === id) this.setCurrent(null);
    if (j.photo) { photoURLs.drop(j.photo); void this.backend.deletePhoto(j.photo); }
    this.onChange();
  }

  logSession(id: string, delta: number): void {
    const j = this.jar(id);
    if (!j) return;
    void this.save({ ...j, sessions: Math.max(Jars.sessionCount(j) + delta, 0) });
  }
  setFinished(id: string, finished: boolean): void {
    const j = this.jar(id);
    if (j) void this.save({ ...j, finished });
  }
  setFlavors(id: string, flavors: string[]): void {
    const j = this.jar(id);
    if (j) void this.save({ ...j, flavors });
  }

  /** Adds a dab to a jar and counts the session. */
  addDab(dab: JarDab, jarID: string): boolean {
    const j = this.jar(jarID);
    if (!j) return false;
    const d = { ...dab };
    if (d.rating !== undefined) d.rating = Dabs.clamp(d.rating);
    if (d.grams !== undefined) d.grams = Dabs.clampGrams(d.grams);
    void this.save({ ...j, dabs: [...(j.dabs ?? []), d], sessions: Jars.sessionCount(j) + 1 });
    return true;
  }

  updateDab(jarID: string, dabID: string, change: (d: JarDab) => void): void {
    const j = this.jar(jarID);
    if (!j || !j.dabs) return;
    const list = j.dabs.map(d => ({ ...d }));
    const d = list.find(x => x.id === dabID);
    if (!d) return;
    change(d);
    if (d.rating !== undefined) d.rating = Dabs.clamp(d.rating);
    if (d.grams !== undefined) d.grams = Dabs.clampGrams(d.grams);
    if (d.note !== undefined) { const t = d.note.trim().slice(0, 200); if (t) d.note = t; else delete d.note; }
    void this.save({ ...j, dabs: list });
  }

  /** Rated dabs grouped by exact goal temp, best average first. */
  tempRows(j: Jar): DabTempRow[] {
    const groups = new Map<string, JarDab[]>();
    for (const d of j.dabs ?? []) {
      if (d.rating === undefined) continue;
      const k = Dabs.groupKey(d);
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    return [...groups.entries()].map(([key, list]) => ({
      key, goal: list[0].goal, flat: Dabs.isFlat(list[0]), count: list.length,
      avg: round1(list.reduce((a, d) => a + (d.rating ?? 0), 0) / list.length),
    })).sort((a, b) => (b.avg - a.avg) || (b.count - a.count));
  }

  /** One line of advice from flat-temp dabs. */
  tempHint(j: Jar): string | null {
    const flat = this.tempRows(j).filter(r => r.flat && r.goal !== undefined);
    const best = flat[0];
    if (!best || best.goal === undefined) return null;
    const g = best.goal;
    const unit = (j.dabs ?? []).find(d => d.goal === g)?.unit ?? "F";
    const step = unit === "C" ? 5 : 10;
    if (flat.length < 2) return `Only ${g}°${unit} rated so far. Try ${g - step}°${unit} or ${g + step}°${unit} to compare.`;
    const temps = flat.map(r => r.goal!);
    if (g === Math.min(...temps)) return `Your best is your lowest. Try ${g - step}°${unit} next.`;
    if (g === Math.max(...temps)) return `Your best is your highest. Try ${g + step}°${unit} next.`;
    return `Sweet spot looks like ${g}°${unit}.`;
  }

  /** Newest unrated, never-offered dab from the last day. */
  unratedToOffer(now = Date.now()): { jarID: string; dab: JarDab } | null {
    let found: { jarID: string; dab: JarDab } | null = null;
    for (const j of this.jars) for (const d of j.dabs ?? []) {
      if (d.rating === undefined && d.asked !== true && now - Date.parse(d.at) < 86_400_000 && (!found || Date.parse(d.at) > Date.parse(found.dab.at))) found = { jarID: j.id, dab: d };
    }
    return found;
  }

  /** "Worth it?": rating per $/g against your own priced, rated jars (needs 3). */
  verdict(j: Jar): string | null {
    const pg = Jars.perGram(j);
    if (j.rating === undefined || pg === undefined) return null;
    const pool = this.jars.map(x => { const p = Jars.perGram(x); return x.rating !== undefined && p !== undefined ? x.rating / p : null; })
      .filter((v): v is number => v !== null);
    if (pool.length < 3) return null;
    const avg = pool.reduce((a, b) => a + b, 0) / pool.length;
    if (!(avg > 0)) return null;
    const ratio = (j.rating / pg) / avg;
    return ratio >= 1.2 ? "STEAL" : ratio >= 0.9 ? "SOLID" : ratio >= 0.7 ? "FAIR" : "PRICEY";
  }

  spend(now = new Date()): Spend {
    const out: Spend = { month: 0, year: 0, all: 0, pricedJars: 0, byMonth: [] };
    let gramsSum = 0, dollarsWithGrams = 0;
    const months = new Map<number, number>();
    for (const j of this.jars) {
      if (!j.price || j.price <= 0) continue;
      const d = new Date(Jars.boughtOn(j));
      out.pricedJars++;
      out.all += j.price;
      if (d.getFullYear() === now.getFullYear()) {
        out.year += j.price;
        if (d.getMonth() === now.getMonth()) out.month += j.price;
      }
      if (j.grams && j.grams > 0) { gramsSum += j.grams; dollarsWithGrams += j.price; }
      const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      months.set(start, (months.get(start) ?? 0) + j.price);
    }
    if (gramsSum > 0) out.avgPerGram = dollarsWithGrams / gramsSum;
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
    out.byMonth = [...months.entries()].filter(([k]) => k >= cutoff).sort((a, b) => b[0] - a[0]);
    return out;
  }

  // MARK: Backup (browsers can clear site data, so jars can be saved to a file and brought back)

  async exportBackup(): Promise<string> {
    const photos: Record<string, string> = {};
    for (const j of this.jars) {
      if (!j.photo) continue;
      const b = await this.backend.getPhoto(j.photo, false).catch(() => null);
      if (b) photos[j.photo] = await blobToDataURL(b);
    }
    return JSON.stringify({ app: "Torchless", kind: "jars", version: 1, saved: new Date().toISOString(), currentJar: this.currentID, jars: this.jars, photos });
  }

  /** Adds jars from a backup. Jars already here (same id) are replaced by the backup's copy. */
  async importBackup(text: string, makeThumb: (b: Blob) => Promise<Blob>): Promise<number> {
    const data = JSON.parse(text) as { kind?: string; jars?: Jar[]; photos?: Record<string, string>; currentJar?: string };
    if (data.kind !== "jars" || !Array.isArray(data.jars)) throw new Error("not a Torchless jar backup");
    let n = 0;
    for (const j of data.jars) {
      if (!j || typeof j.id !== "string" || typeof j.strain !== "string") continue;
      let change: PhotoChange = { kind: "remove" };
      const src = j.photo ? data.photos?.[j.photo] : undefined;
      if (src) {
        const big = await (await fetch(src)).blob();
        change = { kind: "replace", big, thumb: await makeThumb(big) };
      }
      const clean: Jar = { ...j, review: j.review ?? "", producer: j.producer ?? "", finished: !!j.finished, added: j.added ?? new Date().toISOString(), updated: j.updated ?? new Date().toISOString() };
      if (await this.save(clean, change)) n++;
    }
    if (!this.currentID && data.currentJar) this.setCurrent(data.currentJar);
    return n;
  }
}

function blobToDataURL(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}

// MARK: Photo URLs (object URLs for <img>, cached per photo key)

export const photoURLs = {
  cache: new Map<string, string>(),
  async get(store: JarStore, key: string | undefined, thumb: boolean): Promise<string | null> {
    if (!key) return null;
    const k = `${key}${thumb ? "-t" : ""}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const b = await store.backend.getPhoto(key, thumb).catch(() => null);
    if (!b) return null;
    const url = URL.createObjectURL(b);
    this.cache.set(k, url);
    return url;
  },
  drop(key: string) {
    for (const k of [key, `${key}-t`]) { const u = this.cache.get(k); if (u) { URL.revokeObjectURL(u); this.cache.delete(k); } }
  },
};

// MARK: IndexedDB backend (the browser)

export class IDBJarBackend implements JarBackend {
  private db: Promise<IDBDatabase>;
  constructor(private readonly name = "torchless-jars") {
    this.db = new Promise((res, rej) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  private async tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await this.db;
    return new Promise<T>((res, rej) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      let out: T;
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  loadList() { return this.tx<unknown>("kv", "readonly", s => s.get("jars")).then(v => v ?? null); }
  async saveList(list: Jar[]) { await this.tx("kv", "readwrite", s => s.put(list, "jars")); }
  async putPhoto(key: string, big: Blob, thumb: Blob) {
    // Stored as bytes: older WebKit can't keep Blobs in IndexedDB.
    const [b, t] = await Promise.all([big.arrayBuffer(), thumb.arrayBuffer()]);
    await this.tx("photos", "readwrite", s => { s.put({ type: big.type, data: b }, key); s.put({ type: thumb.type, data: t }, key + "-t"); });
  }
  async getPhoto(key: string, thumb: boolean): Promise<Blob | null> {
    const v = await this.tx<{ type: string; data: ArrayBuffer } | undefined>("photos", "readonly", s => s.get(thumb ? key + "-t" : key));
    if (!v && thumb) return this.getPhoto(key, false);
    return v ? new Blob([v.data], { type: v.type }) : null;
  }
  async deletePhoto(key: string) { await this.tx("photos", "readwrite", s => { s.delete(key); s.delete(key + "-t"); }); }
  getPref(k: string) { try { return localStorage.getItem("torchless." + k); } catch { return null; } }
  setPref(k: string, v: string | null) {
    try { if (v === null) localStorage.removeItem("torchless." + k); else localStorage.setItem("torchless." + k, v); } catch { /* fine */ }
  }
}
