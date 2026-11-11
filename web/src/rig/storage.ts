// The app's saved settings (UserDefaults on iPhone). localStorage in the browser, memory on the bench.

export interface Store {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export class MemoryStore implements Store {
  private m = new Map<string, string>();
  get<T>(key: string): T | null {
    const v = this.m.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  set(key: string, value: unknown): void { this.m.set(key, JSON.stringify(value)); }
  remove(key: string): void { this.m.delete(key); }
}

export class LocalStore implements Store {
  constructor(private readonly prefix = "presh.") {}
  get<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(this.prefix + key);
      return v === null ? null : (JSON.parse(v) as T);
    } catch { return null; }
  }
  set(key: string, value: unknown): void {
    try { localStorage.setItem(this.prefix + key, JSON.stringify(value)); } catch { /* storage off: fine */ }
  }
  remove(key: string): void {
    try { localStorage.removeItem(this.prefix + key); } catch { /* fine */ }
  }
}
