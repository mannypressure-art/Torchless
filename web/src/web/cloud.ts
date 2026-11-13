// Sign-in (Google or Apple, through Supabase "Presh") and the shared catalog: a signed-in user's jar rating goes
// up, GLOBAL (everyone's average) comes back. Port of PreshAccount.swift and JarSync.swift, with the same product
// key, tables and steps as the iPhone app (agreed 2026-11-12). Only the jar's own 0-10 rating is ever sent.
// Dab history, dab ratings, temps, sizes, prices and photos never leave the device. Nothing here talks to the rig.

import { AuthClient, Session } from "@supabase/auth-js";
import { PostgrestClient } from "@supabase/postgrest-js";
import { JarStore, Jar, Takedown } from "./jars";
import { PhotoShelf } from "./shared-photos";

export const SERVER_URL = "https://jaxwybhjvrqxsihcnxev.supabase.co";
export const SERVER_KEY = "sb_publishable_b7eEes3g3e7EAd8bl8-1cQ_xXwvRj37";

// MARK: Product key (same as the server's generated products.norm_key)

export const CatalogKey = {
  strip: (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  category: (c?: string) => c ?? "Other",
  key(producer: string, strain: string, c?: string): string {
    return CatalogKey.strip(producer) + "|" + CatalogKey.strip(strain) + "|" + CatalogKey.category(c).toLowerCase();
  },
  /** The server needs a producer (1-60) and strain (1-80) with something left after stripping. */
  usable(j: Jar): boolean {
    const p = j.producer.trim(), s = j.strain.trim();
    return p.length > 0 && p.length <= 60 && s.length > 0 && s.length <= 80 && !!CatalogKey.strip(p) && !!CatalogKey.strip(s);
  },
};

export const AccountRules = {
  cleanHandle(raw: string): string {
    let h = raw.trim();
    if (h.startsWith("@")) h = h.slice(1);
    return h.replace(/[^A-Za-z0-9._]/g, "").slice(0, 30);
  },
  nameOK: (n: string) => { const t = n.trim().length; return t >= 2 && t <= 30; },
};

/** Just the two parts of Supabase the app uses (sign-in and tables), without realtime or storage. */
export interface Server { auth: InstanceType<typeof AuthClient>; rest: PostgrestClient; from: PostgrestClient["from"]; rpc: PostgrestClient["rpc"]; fetch: typeof fetch }
export function makeServer(): Server {
  const auth = new AuthClient({
    url: SERVER_URL + "/auth/v1", headers: { apikey: SERVER_KEY, Authorization: "Bearer " + SERVER_KEY },
    storageKey: "torchless.auth", flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
  });
  const authed: typeof fetch = async (input, init = {}) => {
    const { data } = await auth.getSession();
    const headers = new Headers(init.headers);
    headers.set("apikey", SERVER_KEY);
    headers.set("Authorization", "Bearer " + (data.session?.access_token ?? SERVER_KEY));
    return fetch(input, { ...init, headers });
  };
  const rest = new PostgrestClient(SERVER_URL + "/rest/v1", { headers: { apikey: SERVER_KEY }, fetch: authed });
  return { auth, rest, from: rest.from.bind(rest), rpc: rest.rpc.bind(rest), fetch: authed };
}

export interface Profile { id: string; display_name: string; ig_handle: string | null }
export type AccountState = "signedOut" | "needsProfile" | "ready";

// MARK: Account

export class Account {
  state: AccountState = "signedOut";
  profile: Profile | null = null;
  busy = false;
  problem: string | null = null;
  onChange: () => void = () => {};
  readonly db: Server;
  private session: Session | null = null;

  constructor(db?: Server) {
    this.db = db ?? makeServer();
    this.db.auth.onAuthStateChange((_e: string, s: Session | null) => {
      const had = this.session?.user.id;
      this.session = s;
      if (!s) { this.profile = null; this.state = "signedOut"; this.onChange(); return; }
      if (had !== s.user.id) { if (this.state === "signedOut") this.state = "needsProfile"; void this.loadProfile(); }
    });
  }

  get userID(): string | null { return this.session?.user.id ?? null; }
  get signedIn(): boolean { return !!this.session; }

  private say(text: string | null) { this.problem = text; this.onChange(); }

  /** Goes to Google or Apple and comes back to this page. */
  async signIn(provider: "google" | "apple"): Promise<void> {
    this.busy = true; this.say(null);
    const back = location.origin + location.pathname;
    const { error } = await this.db.auth.signInWithOAuth({ provider, options: { redirectTo: back } });
    if (error) { this.busy = false; this.say("Sign in didn't go through. Check your signal and try again."); }
  }

  async signOut(): Promise<void> {
    await this.db.auth.signOut().catch(() => undefined);
    this.session = null; this.profile = null; this.state = "signedOut"; this.problem = null;
    this.onChange();
  }

  async loadProfile(): Promise<void> {
    const id = this.userID;
    if (!id) return;
    const { data, error } = await this.db.from("profiles").select("id,display_name,ig_handle").eq("id", id);
    if (error) { this.say("Can't load your profile right now."); return; }
    this.profile = (data?.[0] as Profile | undefined) ?? null;
    this.state = this.profile ? "ready" : "needsProfile";
    this.problem = null;
    this.onChange();
  }

  /** Creates the profile (first time, needs the 21+ confirmation) or updates name and handle. */
  async saveProfile(name: string, igHandle: string, confirmed21: boolean): Promise<boolean> {
    const id = this.userID;
    if (!id) return false;
    const cleanName = name.trim();
    const handle = AccountRules.cleanHandle(igHandle);
    if (!AccountRules.nameOK(cleanName)) { this.say("Pick a name 2 to 30 characters long."); return false; }
    if (!this.profile && !confirmed21) { this.say("Torchless is 21 and up only."); return false; }
    this.busy = true; this.onChange();
    const row: Record<string, unknown> = { display_name: cleanName, ig_handle: handle || null };
    const res = this.profile
      ? await this.db.from("profiles").update(row).eq("id", id)
      : await this.db.from("profiles").insert({ ...row, id, adult_confirmed_at: new Date().toISOString() });
    this.busy = false;
    if (!res.error) {
      this.profile = { id, display_name: cleanName, ig_handle: handle || null };
      this.state = "ready"; this.problem = null; this.onChange();
      return true;
    }
    const taken = res.error.code === "23505" || /display_name/.test(res.error.message);
    this.say(taken ? "That name's taken. Try another." : "Couldn't save that. Try again in a bit.");
    return false;
  }

  /** Removes the account, profile and shared ratings (server function delete_account). Jars on this device stay. */
  async deleteAccount(store: JarStore): Promise<boolean> {
    this.busy = true; this.onChange();
    const { error } = await this.db.rpc("delete_account");
    this.busy = false;
    if (error) { this.say("Couldn't delete your account. Try again in a bit."); return false; }
    for (const j of store.jars) {
      if (j.sentProductID || j.sentScore !== undefined) await store.setServer(j.id, x => { delete x.sentProductID; delete x.sentScore; });
    }
    await this.signOut();
    return true;
  }
}

// MARK: Rating sync and GLOBAL

interface Row { id: string; merged_into: string | null }
interface Stat { product_id: string; rating_count: number; avg_score: number | null }

class SyncStop extends Error { constructor(msg: string, readonly onlyThisJar = false) { super(msg); } }

export class JarSync {
  working = false;
  lastProblem: string | null = null;
  private again = false;
  private lastStats = 0;

  constructor(private readonly store: JarStore, private readonly account: Account) {}

  /** One pass: upload or remove ratings that changed, then refresh GLOBAL. Safe to call often. */
  kick(): void {
    if (this.working) { this.again = true; return; }
    this.working = true;
    void this.pass().catch(() => undefined).finally(() => {
      this.working = false;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  private get db() { return this.account.db; }

  private async pass(): Promise<void> {
    const uid = this.account.state === "ready" ? this.account.userID : null;
    let uploaded = false;
    let problem: string | null = null;

    for (const j of [...this.store.jars]) {
      if (!CatalogKey.usable(j)) continue;
      const key = CatalogKey.key(j.producer, j.strain, j.category);
      const wantShare = uid !== null && j.shareRating !== false && j.rating !== undefined;

      let pid: string | null = j.productKey === key ? j.productID ?? null : null;
      if (!pid) {
        pid = await this.findProduct(key);
        if (!pid && wantShare && uid && !this.rejected.has(key)) {
          try { pid = await this.addProduct(j, uid, key); }
          catch (e) { if (!(e instanceof SyncStop)) throw e; problem = e.message; if (!e.onlyThisJar) break; }
        }
        if (pid || j.productKey !== key) {
          const found = pid;
          await this.store.setServer(j.id, x => { x.productKey = key; if (found) x.productID = found; else delete x.productID; });
        }
      }

      // A rating sent earlier for a product this jar no longer matches: take it back.
      if (uid && j.sentProductID && j.sentProductID !== pid) {
        if (await this.deleteRating(uid, j.sentProductID)) await this.store.setServer(j.id, x => { delete x.sentProductID; delete x.sentScore; });
      }
      if (!uid || !pid) continue;
      if (wantShare && j.rating !== undefined) {
        if (j.sentProductID !== pid || j.sentScore !== j.rating) {
          const r = j.rating;
          let ok = false;
          try { ok = await this.upsertRating(uid, pid, r); }
          catch (e) { if (!(e instanceof SyncStop)) throw e; problem = e.message; break; }
          if (ok) {
            const p = pid;
            await this.store.setServer(j.id, x => { x.sentProductID = p; x.sentScore = r; });
            uploaded = true;
          } else problem = "Couldn't send a rating. It'll retry next time.";
        }
      } else if (j.sentProductID === pid) {
        if (await this.deleteRating(uid, pid)) {
          await this.store.setServer(j.id, x => { delete x.sentProductID; delete x.sentScore; });
          uploaded = true;
        }
      }
    }

    if (uid) await this.takedownPass(uid);
    if (uid) await this.coverPass(uid);
    if (uploaded || Date.now() - this.lastStats > 60_000) await this.refreshGlobal();
    this.lastProblem = problem;
  }

  /** Deleted jars: their shared rating and cover come down. Only this account's own items; others wait. */
  private async takedownPass(uid: string): Promise<void> {
    const keep = [];
    for (const t of Takedown.list()) {
      let left = { ...t };
      if (left.cover) {
        const c = left.cover.split("|");
        if (c.length !== 4) delete left.cover;
        else if (c[3].startsWith(uid + "/")) {
          this.shelf ??= new PhotoShelf(this.account.db.fetch, () => (this.account.state === "ready" ? this.account.userID : null));
          if (await this.shelf.autoDrop(c[2], c[3], c[0])) delete left.cover;
        }
      }
      if (left.pid && (await this.deleteRating(uid, left.pid))) delete left.pid;
      if (left.pid || left.cover) keep.push(left);
    }
    Takedown.save(keep);
  }

  /** The jar's cover photo follows its shared rating (on by default, per-jar switch). Moderated on the server. */
  private shelf: PhotoShelf | null = null;
  private async coverPass(_uid: string): Promise<void> {
    this.shelf ??= new PhotoShelf(this.account.db.fetch, () => (this.account.state === "ready" ? this.account.userID : null));
    for (const j of [...this.store.jars]) {
      const pid = j.sentProductID;
      const want = !!pid && j.shareRating !== false && j.rating !== undefined && j.shareCover !== false && !!j.photo;
      const stem = want ? `${pid}|${j.photo}` : null;
      const sent = j.sentCover?.split("|");
      if (sent && sent.length === 4 && `${sent[0]}|${sent[1]}` !== stem) {
        if (!(await this.shelf.autoDrop(sent[2], sent[3], sent[0]))) continue;
        await this.store.setServer(j.id, x => { delete x.sentCover; });
      } else if (sent && sent.length === 4) continue;  // already up
      if (!stem || j.coverRefused === stem) continue;
      const blob = await this.store.backend.getPhoto(j.photo!, false).catch(() => null);
      if (!blob) continue;
      const r = await this.shelf.autoShare(pid!, blob);
      if (r === "retry") continue;
      if (r === "refused") { await this.store.setServer(j.id, x => { x.coverRefused = stem; }); continue; }
      await this.store.setServer(j.id, x => { x.sentCover = `${stem}|${r.id}|${r.path}`; });
    }
  }

  /** Server refusals that stop the whole pass (moderation SQL): told once, not retried every kick. */
  private stopFor(error: { message?: string } | null): string | null {
    const m = error?.message ?? "";
    if (m.includes("account_banned")) return "Your account can't share ratings right now.";
    if (m.includes("rate_limited")) return "Too many new names today. Try again tomorrow.";
    return null;
  }
  /** Names the server refused (409 on add and still not findable): skipped until the name changes. */
  private rejected = new Set<string>();

  private async findProduct(key: string): Promise<string | null> {
    // Signed in: product_id_for_key also finds names still pending or held by moderation, which a plain
    // select can't see. Until that function is on the server (404), fall back to the select.
    if (this.account.signedIn) {
      const { data, error, status } = await this.db.rpc("product_id_for_key", { p_norm_key: key });
      if (!error) return typeof data === "string" && data ? data : null;
      if (status !== 404) return null;
    }
    const { data, error } = await this.db.from("products").select("id,merged_into").eq("norm_key", key).is("merged_into", null);
    if (error) return null;
    return (data as Row[] | null)?.[0]?.id ?? null;
  }

  /** Follows merged_into from a known product id to the live one (a few hops at most). */
  private async live(id: string): Promise<string | null> {
    let cur = id;
    for (let i = 0; i < 4; i++) {
      const { data, error } = await this.db.from("products").select("id,merged_into").eq("id", cur);
      const row = (data as Row[] | null)?.[0];
      if (error || !row) return null;
      if (!row.merged_into) return row.id;
      cur = row.merged_into;
    }
    return null;
  }

  private async addProduct(j: Jar, uid: string, key: string): Promise<string | null> {
    const { data, error, status } = await this.db.from("products")
      .insert({ producer: j.producer.trim(), strain: j.strain.trim(), category: CatalogKey.category(j.category), created_by: uid })
      .select("id,merged_into");
    if (!error) return (data as Row[] | null)?.[0]?.id ?? null;
    const stop = this.stopFor(error);
    if (stop) throw new SyncStop(stop);
    if (status === 409 || error.code === "23505") {   // someone added it first, or the name was refused
      const id = await this.findProduct(key);
      if (!id) { this.rejected.add(key); throw new SyncStop(`"${j.strain.trim()}" wasn't accepted as a product name, so its rating stays on this phone.`, true); }
      return id;
    }
    return null;
  }

  private async upsertRating(uid: string, product: string, score: number): Promise<boolean> {
    const { error } = await this.db.from("ratings")
      .upsert({ user_id: uid, product_id: product, score: Math.round(score * 10) / 10 }, { onConflict: "user_id,product_id" });
    const stop = this.stopFor(error);
    if (stop) throw new SyncStop(stop);
    return !error;
  }

  private async deleteRating(uid: string, product: string): Promise<boolean> {
    const { error } = await this.db.from("ratings").delete().eq("user_id", uid).eq("product_id", product);
    return !error;
  }

  private async refreshGlobal(): Promise<void> {
    const ids = [...new Set(this.store.jars.map(j => j.productID).filter((x): x is string => !!x))];
    if (!ids.length) { this.lastStats = Date.now(); return; }
    const { data, error } = await this.db.from("product_stats").select("product_id,rating_count,avg_score").in("product_id", ids);
    if (error || !data) return;
    this.lastStats = Date.now();
    const byID = new Map((data as Stat[]).map(s => [s.product_id, s]));
    for (const j of [...this.store.jars]) {
      const p = j.productID;
      if (!p) continue;
      if (!byID.has(p)) {
        const moved = await this.live(p);
        if (moved && moved !== p) { await this.store.setServer(j.id, x => { x.productID = moved; }); continue; }
      }
      const s = byID.get(p);
      const count = s?.rating_count ?? 0;
      const avg = count > 0 && s?.avg_score !== null && s?.avg_score !== undefined ? Number(s.avg_score) : undefined;
      if (j.globalScore !== avg || (j.globalCount ?? 0) !== count) {
        await this.store.setServer(j.id, x => { if (avg === undefined) delete x.globalScore; else x.globalScore = avg; x.globalCount = count; });
      }
    }
  }
}
