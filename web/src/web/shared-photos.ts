// Shared jar photos on the Global shelf (server: server/photos/photos.sql).
// Reading works signed out (anon key). Posting, liking and reporting need an account; the server enforces
// 3 per person per jar, 30 per jar, one like per account, no self-likes, rate limits and moderation.
// Files sit in a private bucket and are read through short-lived signed URLs.

import { SERVER_URL, SERVER_KEY } from "./cloud";

export interface SharedPhoto {
  id: string; product_id: string; path: string; width: number | null; height: number | null;
  like_count: number; mod_status: string; mine: boolean; liked: boolean; created_at: string;
  url?: string;
}

const BUCKET = "jar-photos";
export const SHARE_PER_PERSON = 3;

/** Re-encodes through a canvas: drops EXIF (location, camera, time) and resizes to 1280 px JPEG. */
export async function sharePhotoFromFile(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("image")); img.src = url; });
    // naturalWidth/Height already follow the EXIF orientation (image-orientation: from-image), so the
    // canvas gets the upright picture and the orientation tag isn't needed after.
    const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.82, blob: Blob | null = null;
    for (let i = 0; i < 4; i++) {
      blob = await new Promise<Blob | null>(r => c.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= 900_000) break;
      q -= 0.12;
    }
    if (!blob || blob.size > 1_000_000) throw new Error("too big");
    return { blob, width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}

export class PhotoShelf {
  private cache = new Map<string, SharedPhoto[]>();
  private urls = new Map<string, { url: string; until: number }>();
  private wanted = new Set<string>();
  private loading = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Called with the jar ids whose photos changed. */
  onChange: (ids: string[]) => void = () => {};

  /** fetchAs: the signed-in fetch (adds the user's token), or a plain one for signed-out reading. */
  constructor(private fetchAs: typeof fetch = anonFetch, private userID: () => string | null = () => null) {}

  photos(productID: string): SharedPhoto[] | undefined { return this.cache.get(productID); }
  mineCount(productID: string): number { return (this.cache.get(productID) ?? []).filter(p => p.mine).length; }
  get canPost(): boolean { return !!this.userID(); }

  /** Asks for a jar's photos; requests are batched for 120 ms. */
  want(productID: string): void {
    if (this.cache.has(productID) || this.loading.has(productID)) return;
    this.wanted.add(productID);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 120);
  }
  forget(productID: string): void { this.cache.delete(productID); }

  private async flush(): Promise<void> {
    const ids = [...this.wanted].slice(0, 100);
    ids.forEach(id => { this.wanted.delete(id); this.loading.add(id); });
    if (this.wanted.size && !this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 120);
    try {
      const rows: SharedPhoto[] = await this.json("/rest/v1/rpc/photos_top", { method: "POST", body: JSON.stringify({ p_products: ids, p_per: 12 }) });
      const by = new Map<string, SharedPhoto[]>(ids.map(id => [id, []]));
      for (const r of rows) by.get(r.product_id)?.push(r);
      await this.sign(rows);
      for (const [id, list] of by) this.cache.set(id, list);
    } catch {
      for (const id of ids) this.cache.set(id, []);  // server not set up or offline: show no strip
    } finally {
      ids.forEach(id => this.loading.delete(id));
      this.onChange(ids);
    }
  }

  private async sign(rows: SharedPhoto[]): Promise<void> {
    const now = Date.now();
    const need = rows.filter(r => { const u = this.urls.get(r.path); return !u || u.until < now; }).map(r => r.path);
    if (need.length) {
      const out: { path: string; signedURL?: string | null; error?: string | null }[] =
        await this.json(`/storage/v1/object/sign/${BUCKET}`, { method: "POST", body: JSON.stringify({ expiresIn: 3600, paths: need }) });
      for (const s of out) if (s.signedURL) this.urls.set(s.path, { url: SERVER_URL + "/storage/v1" + s.signedURL, until: now + 50 * 60_000 });
    }
    for (const r of rows) r.url = this.urls.get(r.path)?.url;
  }

  /** Uploads one photo for a jar. Returns null when it went up, or a short reason it didn't. */
  async post(productID: string, file: Blob): Promise<string | null> {
    const me = this.userID();
    if (!me) return "Sign in to share photos.";
    if (this.mineCount(productID) >= SHARE_PER_PERSON) return `You've shared ${SHARE_PER_PERSON} photos of this jar.`;
    let pic: { blob: Blob; width: number; height: number };
    try { pic = await sharePhotoFromFile(file); } catch { return "Couldn't read that photo."; }
    const path = `${me}/${crypto.randomUUID()}.jpg`;
    const up = await this.fetchAs(`${SERVER_URL}/storage/v1/object/${BUCKET}/${path}`,
      { method: "POST", body: pic.blob, headers: { "Content-Type": "image/jpeg", "x-upsert": "false" } }).catch(() => null);
    if (!up?.ok) return "Couldn't upload. Try again in a bit.";
    const ins = await this.fetchAs(`${SERVER_URL}/rest/v1/product_photos`, {
      method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ product_id: productID, user_id: me, path, width: pic.width, height: pic.height }) }).catch(() => null);
    if (!ins?.ok) {
      const why = ins ? await ins.text().catch(() => "") : "";
      await this.removeFile(path);
      if (/photo_limit_mine/.test(why)) return `You've shared ${SHARE_PER_PERSON} photos of this jar.`;
      if (/photo_limit_jar/.test(why)) return "This jar has all the photos it can hold.";
      if (/rate_limited/.test(why)) return "That's a lot of photos today. Try tomorrow.";
      if (/account_banned/.test(why)) return "Your account can't share photos.";
      return "Couldn't share it. Try again in a bit.";
    }
    this.forget(productID); this.want(productID);
    return null;
  }

  async like(p: SharedPhoto, on: boolean): Promise<boolean> {
    if (!this.userID() || p.mine || p.liked === on) return false;
    const r = on
      ? await this.fetchAs(`${SERVER_URL}/rest/v1/photo_likes`, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ photo_id: p.id, user_id: this.userID() }) }).catch(() => null)
      : await this.fetchAs(`${SERVER_URL}/rest/v1/photo_likes?photo_id=eq.${p.id}&user_id=eq.${this.userID()}`, { method: "DELETE" }).catch(() => null);
    // 409: already liked on another device. Keep what the server has.
    if (!r || (!r.ok && r.status !== 409)) return false;
    p.liked = on; p.like_count = Math.max(0, p.like_count + (on ? 1 : -1));
    this.onChange([p.product_id]);
    return true;
  }

  async report(p: SharedPhoto, reason: string): Promise<boolean> {
    const me = this.userID();
    if (!me) return false;
    const r = await this.fetchAs(`${SERVER_URL}/rest/v1/reports`, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ reporter: me, target_type: "photo", target_id: p.id, reason: reason.slice(0, 300) }) }).catch(() => null);
    return !!r && (r.ok || r.status === 409);  // 409: already reported it
  }

  async remove(p: SharedPhoto): Promise<boolean> {
    if (!p.mine) return false;
    const r = await this.fetchAs(`${SERVER_URL}/rest/v1/product_photos?id=eq.${p.id}`, { method: "DELETE" }).catch(() => null);
    if (!r?.ok) return false;
    await this.removeFile(p.path);
    this.cache.set(p.product_id, (this.cache.get(p.product_id) ?? []).filter(x => x.id !== p.id));
    this.onChange([p.product_id]);
    return true;
  }

  /** Before deleting the account: the rows go with it on the server, the files have to be removed here. */
  async removeAllMine(): Promise<void> {
    const me = this.userID();
    if (!me) return;
    try {
      const rows: { path: string }[] = await this.json(`/rest/v1/product_photos?select=path&user_id=eq.${me}`, {});
      if (rows.length) await this.fetchAs(`${SERVER_URL}/storage/v1/object/${BUCKET}`, { method: "DELETE",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: rows.map(r => r.path) }) });
    } catch { /* best effort: leftover files are unreadable once the rows are gone */ }
  }

  private async removeFile(path: string): Promise<void> {
    await this.fetchAs(`${SERVER_URL}/storage/v1/object/${BUCKET}`, { method: "DELETE",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] }) }).catch(() => null);
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const r = await this.fetchAs(SERVER_URL + path, { ...init, headers });
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<T>;
  }
}

const anonFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("apikey", SERVER_KEY);
  headers.set("Authorization", "Bearer " + SERVER_KEY);
  return fetch(input, { ...init, headers });
};
