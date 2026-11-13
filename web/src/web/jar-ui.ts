// Jar screens for the web app, ported from JarViews.swift, JarDabs.swift and JarPrice.swift in the Gauge look:
// the JARS tab (shelf, search, filters, spend), a jar's page (dabbing this, dab history, flavors, price),
// Log a jar / Edit, the spend breakdown, the Home current-jar card and the after-dab rating pop-up.
// Nothing here talks to the rig.

import { JarStore, Jar, JarDab, Jars, Dabs, JarCategory, JarFlavor, SIZE_STOPS, REVIEW_LIMIT, GRAM_PICKS, PhotoChange, photoURLs, uid, allPhotos, PHOTO_LIMIT } from "./jars";
import { cropPhoto } from "./crop";
import { DabWatcher, DabPrompt } from "./dab-watcher";
import type { Account, JarSync } from "./cloud";
import { CatalogKey, SERVER_URL, SERVER_KEY } from "./cloud";

// MARK: Tiny DOM helper (text always goes in as text, never as HTML)

type Kid = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
export function h(tag: string, attrs: Attrs = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
export const tag = (text: string, style = "") => h("span", { class: "tag", style }, text);
/** A line icon from the sheet in index.html (#i-name). Sized by font-size, coloured by the text colour. */
export function icon(name: string, style = ""): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("class", "ico");
  s.setAttribute("aria-hidden", "true");
  if (style) s.setAttribute("style", style);
  const u = document.createElementNS(ns, "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "S"}`;

// MARK: Photos

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("image")); img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function scaled(img: HTMLImageElement, maxSide: number, quality: number): Promise<Blob> {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", quality));
}
/** Same sizes as the iPhone app: 1600 px long side, and a 480 px thumbnail for the shelf. */
export async function photoFromFile(file: Blob): Promise<{ big: Blob; thumb: Blob }> {
  const img = await loadImage(file);
  return { big: await scaled(img, 1600, 0.82), thumb: await scaled(img, 480, 0.78) };
}
export async function thumbFromBlob(b: Blob): Promise<Blob> { return scaled(await loadImage(b), 480, 0.78); }

/** Square photo slot: the jar photo, or a lid with the producer's first letter. */
function jarPhoto(store: JarStore, j: { photo?: string; producer: string }, size: string, radius: number, thumb = true, override?: string | null): HTMLElement {
  const box = h("div", { class: "jarPhoto", style: `width:${size};border-radius:${radius}px` });
  const lid = lidSVG(j.producer);
  box.append(lid);
  const put = (url: string | null) => { if (url) lid.replaceWith(h("img", { src: url, alt: "" })); };
  if (override !== undefined) put(override);
  else if (j.photo) void photoURLs.get(store, j.photo, thumb).then(put);
  return box;
}
function lidSVG(producer: string): Element {
  const letter = (producer.trim()[0] ?? "T").toUpperCase();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "lid");
  svg.innerHTML = `<circle cx="50" cy="50" r="49" class="lidBody"/><circle cx="50" cy="50" r="40" fill="none" class="lidRing"/>` +
    `<path d="M50 20 A30 30 0 1 1 24 35" fill="none" class="lidArc" transform="rotate(-60 50 50)"/>`;
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", "50"); t.setAttribute("y", "62"); t.setAttribute("class", "lidLetter");
  t.textContent = letter;
  svg.append(t);
  return svg;
}

/** The rating dial: a 270° arc filled in gold up to the score out of 10. */
function ratingDial(rating: number | undefined, size: number): HTMLElement {
  const r = 38, c = 2 * Math.PI * r, sweep = 0.75 * c;
  const frac = (rating ?? 0) / 10;
  const box = h("div", { class: "dial", style: `width:${size}px;height:${size}px`, role: "img",
    "aria-label": rating === undefined ? "Not rated" : `Rated ${Jars.ratingText(rating)} out of 10` });
  box.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" class="dialFace"/>` +
    `<circle cx="50" cy="50" r="${r}" class="dialTrack" stroke-dasharray="${sweep} ${c}" transform="rotate(135 50 50)"/>` +
    (rating !== undefined ? `<circle cx="50" cy="50" r="${r}" class="dialFill" stroke-dasharray="${sweep * frac} ${c}" transform="rotate(135 50 50)"/>` : "") +
    `</svg>`;
  box.append(h("div", { class: "dialText" },
    h("b", { style: `font-size:${Math.round(size * 0.3)}px;color:${rating === undefined ? "var(--dim)" : "var(--gold)"}` }, Jars.ratingText(rating)),
    tag(rating === undefined ? "NOT RATED" : "YOURS", "font-size:8.5px")));
  return box;
}

// MARK: Sheets (full-screen pages that stack)

const sheetRoot = () => document.getElementById("sheets")!;
export function openSheet(build: (close: () => void) => HTMLElement, kind: "page" | "card" = "page"): () => void {
  const wrap = h("div", { class: kind === "page" ? "page" : "cardSheet" });
  let closed = false;
  const gone = () => { wrap.remove(); document.body.classList.toggle("sheetOpen", sheetRoot().childElementCount > 0); };
  // Closing fades out for a moment (CSS .closing); taps go straight through to what is underneath meanwhile.
  const close = () => {
    if (closed) return;
    closed = true;
    let still = true;
    try { still = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* no matchMedia: close at once */ }
    if (still) { gone(); return; }
    wrap.classList.add("closing");
    setTimeout(gone, 170);
  };
  wrap.append(build(close));
  sheetRoot().append(wrap);
  document.body.classList.add("sheetOpen");
  return close;
}
export function topBar(left: HTMLElement | null, mid: HTMLElement | null, right: HTMLElement | null): HTMLElement {
  return h("div", { class: "topBar" }, left ?? h("span"), mid ?? h("span"), right ?? h("span"));
}
export const textBtn = (label: string, onclick: () => void, color = "var(--sub)") =>
  h("button", { class: "textBtn", style: `color:${color}`, onclick }, label);

export function confirmSheet(title: string, body: string, yes: string, no: string, onYes: () => void) {
  openSheet(close => h("div", { class: "cardBody" },
    h("h3", {}, title), h("p", { class: "sub" }, body),
    h("div", { class: "row", style: "gap:10px;margin-top:16px" },
      h("button", { class: "btn2", style: "flex:1", onclick: close }, no),
      h("button", { class: "btn2 danger", style: "flex:1", onclick: () => { close(); onYes(); } }, yes))), "card");
}

// MARK: The jar screens

export interface JarUI {
  renderHome(): void;
  renderJars(): void;
  renderOpen(): void;
  renderPrompt(): void;
  /** Redraws the account page if it is open. */
  renderAccount(): void;
  openAccount(): void;
}

export interface Cloud { account: Account; sync: JarSync }

export function mountJars(store: JarStore, watcher: DabWatcher, showTab: (t: string) => void, cloud?: Cloud): JarUI {
  // Filters on the shelf
  let filter: "OPEN" | "FINISHED" | "GLOBAL" = "OPEN";
  let category: string | null = null;
  let query = "";
  const openPages = new Set<() => void>();   // re-renders for open jar pages
  const galleryAt = new Map<string, number>();   // which photo each jar page is showing
  const rerenderAll = () => { for (const f of openPages) f(); };

  // MARK: Home: the current jar card
  let justSet = false;
  function renderHome() {
    const box = document.getElementById("curJar")!;
    const j = store.current;
    const main = h("button", { class: "curMain", "aria-label": j ? `Now dabbing ${j.strain}. Open jar.` : "Pick a jar",
      onclick: () => { if (j) openJar(j.id); else showTab("jars"); } });
    if (j) {
      const bits: string[] = [];
      const pg = Jars.perGram(j);
      if (pg !== undefined) bits.push(Jars.money(pg) + "/g");
      const rated = (j.dabs ?? []).map(d => d.rating).filter((r): r is number => r !== undefined);
      if (rated.length) bits.push("DAB AVG " + Jars.ratingText(rated.reduce((a, b) => a + b, 0) / rated.length));
      else if (j.rating !== undefined) bits.push("RATED " + Jars.ratingText(j.rating));
      bits.push(plural((j.dabs ?? []).length, "DAB"));
      main.append(jarPhoto(store, j, "56px", 12),
        h("div", { class: "curText" },
          h("span", { class: "tag", style: `font-size:9px;color:${justSet ? "var(--gold)" : "var(--live)"}` }, justSet ? icon("check", "font-size:11px;stroke-width:2.6;margin-right:4px") : null, "NOW DABBING"),
          h("b", {}, j.strain), h("small", {}, bits.join(" · "))));
    } else {
      main.append(h("span", { class: "curIcon" }, jarIcon()),
        h("div", { class: "curText" }, tag("JARS", "font-size:9px"), h("b", { class: "twoLine" }, "Pick what you're dabbing"), h("small", { class: "twoLine" }, "Then every dab gets rated.")));
    }
    const plus = h("button", { class: "plusKey", "aria-label": "Add a jar", onclick: () => editJar(null, newID => {
      // A jar added from Home becomes the current jar, and the card says so.
      store.setCurrent(newID);
      justSet = true;
      setTimeout(() => { justSet = false; renderHome(); }, 4000);
    }) }, "+");
    box.replaceChildren(main, plus);
  }

  // MARK: The JARS tab
  function renderJars() {
    const panel = document.getElementById("jarsPanel")!;
    const kids: HTMLElement[] = [];
    const n = store.jars.length;
    kids.push(h("div", { class: "row", style: "margin-top:14px" },
      h("div", {}, h("h2", {}, "JARS"), tag(`${plural(n, "JAR")} · ${store.openCount} OPEN`, "display:block;margin-top:6px")),
      cloud ? accountButton() : null,
      h("button", { class: "logIt", style: cloud ? "" : "margin-left:auto", "aria-label": "Log a jar", onclick: () => editJar(null) }, "+ LOG IT")));
    if (store.problem) kids.push(h("div", { class: "problem" }, store.problem));
    if (store.jars.some(j => j.price !== undefined)) {
      const s = store.spend();
      kids.push(h("button", { class: "panel spendStrip", onclick: spendSheet },
        cell("THIS MONTH", Jars.money(s.month)), cell("THIS YEAR", Jars.money(s.year)),
        cell("AVG / G", Jars.money(s.avgPerGram), "var(--gold)"), h("span", { class: "chev" }, "›")));
    }
    if (n) {
      const input = h("input", { type: "search", placeholder: "Search strain, producer, notes", value: query, autocomplete: "off",
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; renderGrid(); } }) as HTMLInputElement;
      kids.push(h("label", { class: "panel search" }, h("span", { class: "dim", style: "display:flex;font-size:20px" }, icon("search")), input));
    }
    const chips = h("div", { class: "chips" });
    chips.className = "jarTabs";
    for (const [f, label, cls] of [["OPEN", "MINE", "tMine"], ["FINISHED", "GRAVEYARD", "tGrave"], ["GLOBAL", "GLOBAL", "tGlob"]] as const) {
      chips.append(h("button", { class: `jarTab ${cls}` + (filter === f ? " on" : ""), "aria-pressed": String(filter === f), onclick: () => { filter = f; renderJars(); } }, label));
    }
    kids.push(chips);
    if (store.usedCategories.length && filter !== "GLOBAL") {
      const row = h("div", { class: "chips scrollX" });
      for (const c of [null, ...store.usedCategories]) {
        row.append(h("button", { class: "chip gold" + (category === c ? " on" : ""), onclick: () => { category = c; renderJars(); } }, (c ?? "Every type").toUpperCase()));
      }
      kids.push(row);
    }
    const grid = h("div", { id: "jarGrid" });
    kids.push(grid);
    kids.push(backupBox());
    panel.replaceChildren(...kids);
    renderGrid();
  }

  function renderGrid() {
    const grid = document.getElementById("jarGrid");
    if (!grid) return;
    if (filter === "GLOBAL") { renderGlobal(grid); return; }
    const searching = category !== null || query.trim() !== "";
    const shown = store.shelf.filter(j => {
      if (filter === "OPEN" && j.finished) return false;
      if (filter === "FINISHED" && !j.finished) return false;
      if (category && j.category !== category) return false;
      return Jars.matches(j, query);
    });
    if (!shown.length && searching && store.jars.length) {
      grid.replaceChildren(h("div", { class: "panel pad center" }, h("h3", {}, "No match."),
        h("button", { class: "btn2 wide", style: "color:var(--live)", onclick: () => { query = ""; category = null; renderJars(); } }, "CLEAR SEARCH")));
      return;
    }
    if (!shown.length) {
      const all = filter === "OPEN" && !store.jars.length;
      grid.replaceChildren(h("div", { class: "panel pad center" },
        h("div", { style: "width:96px;margin:0 auto" }, lidSVG("")),
        h("h3", {}, all ? "No jars yet." : "Nothing here."),
        h("p", { class: "mono sub" }, all ? "Snap the jar, name the strain, say how it hit." : filter === "OPEN" ? "Jars show up here once you mark them open." : "Finished jars rest here, ratings and all."),
        all ? h("button", { class: "goldBtn", onclick: () => editJar(null) }, "LOG YOUR FIRST JAR") : null));
      return;
    }
    const g = h("div", { class: "jarGrid" });
    for (const j of shown) {
      const photo = jarPhoto(store, j, "100%", 12);
      if (store.currentID === j.id) photo.append(h("span", { class: "curBadge" }, "CURRENT"));
      g.append(h("button", { class: "panel jarCard" + (j.finished ? " done" : ""), onclick: () => openJar(j.id) },
        photo,
        tag(j.producer ? j.producer.toUpperCase() : "NO PRODUCER", "font-size:8.5px;display:block;margin-top:8px"),
        h("b", { class: "jarName" }, j.strain),
        j.category ? h("small", { class: "mono sub" }, j.category) : null,
        h("div", { class: "row", style: "margin-top:4px" }, tag("YOURS", "font-size:8px"),
          h("b", { class: "cond", style: `font-size:20px;color:${j.rating === undefined ? "var(--dim)" : "var(--gold)"}` }, Jars.ratingText(j.rating)),
          statusTag(j.finished))));
    }
    grid.replaceChildren(g);
  }

  // MARK: Global shelf: jars other people logged (approved ones only). Reading needs no sign-in.
  let globalRows: { id: string; producer: string; strain: string; category?: string; avg?: number; count: number }[] | null = null;
  let globalFailed = false;
  async function loadGlobal(): Promise<void> {
    const get = async (path: string) => {
      const r = await fetch(`${SERVER_URL}/rest/v1/${path}`, { headers: { apikey: SERVER_KEY, Authorization: "Bearer " + SERVER_KEY } });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    try {
      const prods: { id: string; producer: string; strain: string; category?: string }[] =
        await get("products?select=id,producer,strain,category&merged_into=is.null&order=created_at.desc&limit=200");
      const stats: { product_id: string; rating_count: number; avg_score: number }[] = prods.length
        ? await get(`product_stats?select=product_id,rating_count,avg_score&product_id=in.(${prods.map(p => p.id).join(",")})`) : [];
      const by = new Map(stats.map(x => [x.product_id, x]));
      globalRows = prods.map(p => ({ ...p, avg: by.get(p.id)?.avg_score, count: by.get(p.id)?.rating_count ?? 0 }))
        .sort((a, b) => (b.count - a.count) || a.strain.localeCompare(b.strain));
      globalFailed = false;
    } catch { globalFailed = true; }
    if (filter === "GLOBAL") renderGrid();
  }
  function renderGlobal(grid: HTMLElement) {
    if (globalRows === null && !globalFailed) { void loadGlobal(); grid.replaceChildren(h("p", { class: "mono dim center" }, "Loading the global shelf…")); return; }
    if (globalFailed) { grid.replaceChildren(h("div", { class: "panel pad center" }, h("p", { class: "mono sub" }, "Couldn't reach the global shelf."),
      h("button", { class: "btn2 wide", onclick: () => { globalFailed = false; globalRows = null; renderGrid(); } }, "TRY AGAIN"))); return; }
    const mine = new Set(store.jars.map(j => j.productID).filter(Boolean));
    const rows = globalRows!.filter(r => Jars.matches({ strain: r.strain, producer: r.producer, review: "", category: r.category } as Jar, query));
    if (!rows.length) { grid.replaceChildren(h("div", { class: "panel pad center" }, h("p", { class: "mono sub" }, query ? "No match." : "Nothing on the global shelf yet."))); return; }
    const list = h("div", { class: "stackS" });
    for (const r of rows) {
      const have = mine.has(r.id);
      const add = (finished: boolean) => editJar(null, newID => { if (!finished) store.setCurrent(newID); },
        { strain: r.strain, producer: r.producer, category: r.category, productID: r.id, finished });
      list.append(h("div", { class: "panel globCard" },
        h("div", { class: "row" },
          h("div", { style: "flex:1;min-width:0" }, tag(r.producer ? r.producer.toUpperCase() : "NO PRODUCER", "font-size:8.5px;display:block"),
            h("b", { class: "jarName", style: "display:block" }, r.strain), r.category ? h("small", { class: "mono sub", style: "display:block" }, r.category) : null),
          h("div", { class: "center" }, tag("GLOBAL", "font-size:8px;color:var(--glob)"),
            h("b", { class: "cond", style: `font-size:26px;display:block;color:${r.avg === undefined ? "var(--dim)" : "var(--glob)"}` }, Jars.ratingText(r.avg)),
            h("small", { class: "mono dim", style: "font-size:9px" }, r.count === 1 ? "1 rating" : `${r.count} ratings`))),
        have ? h("p", { class: "mono dim", style: "font-size:10px;margin:8px 0 0" }, "Already on your shelf.") :
          h("div", { class: "row", style: "gap:8px;margin-top:10px" },
            h("button", { class: "btn2 tCollBtn", style: "flex:1", onclick: () => add(false) }, "+ COLLECTION"),
            h("button", { class: "btn2 tGraveBtn", style: "flex:1", onclick: () => add(true) }, "GRAVEYARD"))));
    }
    grid.replaceChildren(list);
  }

  let backupNote = "Jars live on this phone, in this browser. Save a backup now and then so clearing the browser can't lose them.";
  function backupBox(): HTMLElement {
    const file = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const n = await store.importBackup(await f.text(), thumbFromBlob);
        backupNote = `Brought back ${plural(n, "jar").toLowerCase()}.`;
      } catch { backupNote = "That file isn't a Torchless jar backup."; }
      msg.textContent = backupNote;
      (e.target as HTMLInputElement).value = "";
    } }) as HTMLInputElement;
    const msg = h("p", { class: "mono dim", style: "margin:8px 0 0" }, backupNote);
    return h("div", { class: "panel pad", style: "margin-top:18px" },
      h("div", { class: "row" }, tag("BACKUP"), tag("ONLY YOU", "margin-left:auto;font-size:8.5px")),
      msg,
      h("div", { class: "row", style: "gap:10px;margin-top:12px" },
        h("button", { class: "btn2", style: "flex:1", disabled: !store.jars.length, onclick: async () => {
          const blob = await store.exportBackup();
          const a = h("a", { href: URL.createObjectURL(blob),
            download: `Torchless-jars-${new Date().toISOString().slice(0, 10)}.json` }) as HTMLAnchorElement;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          backupNote = "Backup saved. Keep the file somewhere safe, like Files or Drive.";
          msg.textContent = backupNote;
        } }, "Save backup"),
        h("button", { class: "btn2", style: "flex:1", onclick: () => file.click() }, "Restore"), file));
  }

  // MARK: A jar's page
  function openJar(id: string) {
    let rerender = () => {};
    openSheet(close => {
      const body = h("div", { class: "pageBody" });
      const done = () => { openPages.delete(rerender); close(); };
      rerender = () => body.replaceChildren(...jarPage(id, done));
      rerender();
      return body;
    });
    openPages.add(rerender);
  }

  function jarPage(id: string, done: () => void): HTMLElement[] {
    const j = store.jar(id);
    if (!j) return [topBar(textBtn("Done", done), null, null), h("p", { class: "center dim", style: "padding:40px" }, "This jar is gone.")];
    const out: HTMLElement[] = [];
    out.push(topBar(textBtn("Done", done), statusTag(j.finished), textBtn("Edit", () => editJar(j), "var(--live)")));
    out.push(gallery(j));
    out.push(currentBar(j));
    out.push(h("div", { class: "row", style: "gap:14px;align-items:center" },
      h("div", { style: "flex:1;min-width:0" },
        tag(j.producer ? j.producer.toUpperCase() : "NO PRODUCER", "font-size:9.5px"),
        h("div", { class: "bigName" }, j.strain),
        j.category ? h("div", { class: "mono sub" }, j.category) : null,
        tag("LOGGED " + new Date(j.added).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }).toUpperCase(), "font-size:8.5px")),
      ratingDial(j.rating, 112)));
    out.push(h("div", { class: "panel pad" }, tag("REVIEW", "font-size:9.5px"),
      h("p", { class: "mono review", style: j.review ? "" : "color:var(--dim)" }, j.review || "No words yet. Tap Edit to say how it hit.")));
    if (cloud) out.push(globalCard(j));
    out.push(dabsCard(j));
    out.push(priceCard(j));
    out.push(h("div", { class: "row", style: "gap:10px" },
      h("button", { class: "btn2 tall", style: "flex:1", onclick: () => store.setFinished(j.id, !j.finished) }, j.finished ? "BACK OPEN" : "TO THE GRAVEYARD"),
      h("button", { class: "btn2 tall", style: "width:64px;color:var(--warn)", "aria-label": "Delete jar", onclick: () =>
        confirmSheet("Delete this jar?", "The photos and review go too. This can't be undone.", "Delete jar", "Keep it", () => { void store.delete(j.id); done(); }) }, icon("trash", "font-size:22px"))));
    return out;
  }

  // A jar's photo set (JarGallery.swift): swipe through, add (camera or library, then crop), make cover, move, delete.
  function gallery(j: Jar): HTMLElement {
    const stems = allPhotos(j);
    let index = Math.min(galleryAt.get(j.id) ?? 0, Math.max(stems.length - 1, 0));
    const setIndex = (i: number) => { galleryAt.set(j.id, i); rerenderAll(); };
    const current = stems[index];
    const canAdd = stems.length < PHOTO_LIMIT;

    const main = jarPhoto(store, { photo: current, producer: j.producer }, "100%", 20, false);
    if (index === 0 && stems.length > 1) main.append(h("span", { class: "galTag cover" }, "COVER"));
    if (stems.length > 1) main.append(h("span", { class: "galTag count" }, `${index + 1} / ${stems.length}`));
    let sx: number | null = null, sy = 0;
    main.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; });
    main.addEventListener("pointerup", e => {
      if (sx === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
      if (dx < 0 && index < stems.length - 1) setIndex(index + 1);
      if (dx > 0 && index > 0) setIndex(index - 1);
    });
    main.style.touchAction = "pan-y";

    const add = async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      input.value = "";
      if (!f) return;
      try {
        const out = await cropPhoto(f);
        if (!out) return;
        const thumb = await thumbFromBlob(out);
        if (await store.addPhoto(j.id, out, thumb)) setIndex(allPhotos(store.jar(j.id) ?? j).length - 1);
      } catch { store.problem = "Couldn't read that photo. Try another one."; rerenderAll(); }
    };
    const pick = h("input", { type: "file", accept: "image/*", hidden: true, onchange: add }) as HTMLInputElement;
    const snap = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: add }) as HTMLInputElement;

    const strip = h("div", { class: "galStrip scrollX" });
    stems.forEach((k, i) => {
      const t = jarPhoto(store, { photo: k, producer: j.producer }, "58px", 10);
      strip.append(h("button", { class: "galThumb" + (i === index ? " on" : ""), "aria-label": i === 0 ? "Cover photo" : `Photo ${i + 1}`, onclick: () => setIndex(i) }, t));
    });
    if (canAdd) strip.append(
      h("button", { class: "galAdd", "aria-label": "Take a photo", onclick: () => snap.click() }, h("span", { style: "display:flex;font-size:20px" }, icon("camera")), h("b", {}, "SNAP")),
      h("button", { class: "galAdd", "aria-label": "Add a photo from your library", onclick: () => pick.click() }, h("span", { style: "display:flex;font-size:20px" }, icon("image")), h("b", {}, "PICK")),
      pick, snap);

    const box = h("div", { class: "stackS" }, main, strip);
    if (current) {
      const move = (by: number) => {
        const k = index + by;
        if (k < 0 || k >= stems.length) return;
        const order = [...stems];
        [order[index], order[k]] = [order[k], order[index]];
        galleryAt.set(j.id, k);
        void store.reorderPhotos(j.id, order);
      };
      const key = (label: string, text: string, on: boolean, fn: () => void) => h("button", { class: "galKey", "aria-label": label, disabled: !on, onclick: fn }, text);
      box.append(h("div", { class: "row", style: "gap:8px;align-items:center" },
        index > 0 ? h("button", { class: "galCover", onclick: () => { galleryAt.set(j.id, 0); void store.reorderPhotos(j.id, [current, ...stems.filter(x => x !== current)]); } }, "MAKE COVER") : null,
        h("span", { style: "flex:1" }),
        stems.length > 1 ? key("Move photo left", "‹", index > 0, () => move(-1)) : null,
        stems.length > 1 ? key("Move photo right", "›", index < stems.length - 1, () => move(1)) : null,
        h("button", { class: "galKey", style: "color:var(--warn)", "aria-label": "Delete this photo", onclick: () =>
          confirmSheet("Delete this photo?", index === 0 && stems.length > 1 ? "The next photo becomes the cover." : "This can't be undone.", "Delete photo", "Keep it", () => { void store.deletePhoto(j.id, current); }) }, icon("trash", "font-size:20px"))));
    }
    return box;
  }

  function currentBar(j: Jar): HTMLElement {
    const isCur = store.currentID === j.id;
    const btn = h("button", { class: "curBar" + (isCur ? " on" : ""), disabled: j.finished,
      "aria-label": isCur ? "Now dabbing this jar. Tap to stop." : "Set as the jar you're dabbing",
      onclick: () => {
        if (isCur) { store.setCurrent(null); flashFor = null; }
        else { store.setCurrent(j.id); flashFor = j.id; try { navigator.vibrate?.(10); } catch { /* fine */ } }
      } }, icon(isCur ? "check" : "flame", "font-size:22px;stroke-width:2.2;margin-right:8px"), isCur ? "NOW DABBING" : "DABBING THIS");
    const note = j.finished ? "Graveyard jars can't be the current jar."
      : isCur ? (flashFor === j.id ? "Got it. Your next dab logs to this jar." : "Your dabs log to this jar. Tap to stop.")
      : "Tap so your next dab gets logged and rated here.";
    return h("div", {}, btn, h("p", { class: "mono", style: `margin:6px 0 0;color:${isCur ? "var(--gold)" : "var(--dim)"}` }, note));
  }
  let flashFor: string | null = null;

  function dabsCard(j: Jar): HTMLElement {
    const dabs = j.dabs ?? [];
    const rows = store.tempRows(j);
    const best = rows.find(r => r.flat) ?? rows[0];
    const card = h("div", { class: "panel pad stackS" }, h("div", { class: "row" }, tag("DABS", "font-size:9.5px"), tag(`${dabs.length} LOGGED`, "margin-left:auto;font-size:8.5px")));
    if (!dabs.length) card.append(h("p", { class: "mono dim" }, "No dabs yet. Tap DABBING THIS, heat up, and you'll be asked to rate it once the rig cools."));
    if (best) {
      card.append(h("div", {}, tag("BEST SO FAR", "font-size:8.5px"),
        h("div", { class: "row", style: "align-items:baseline;gap:8px" },
          h("b", { class: "cond", style: "font-size:28px" }, best.key),
          h("b", { class: "cond", style: "font-size:22px;color:var(--gold)" }, Jars.ratingText(best.avg) + " avg"),
          h("span", { class: "mono dim" }, `(${best.count})`))));
      const hint = store.tempHint(j);
      if (hint) card.append(h("p", { class: "mono", style: "color:var(--live);margin:0" }, hint));
      if (rows.length > 1) {
        const list = h("div", { class: "tempRows" });
        for (const r of rows) list.append(h("div", { class: "row" },
          h("span", { class: "cond", style: `font-size:17px;color:${r.flat ? "var(--ink)" : "var(--sub)"}` }, r.key),
          h("span", { class: "mono dim", style: "margin-left:auto" }, `${r.count} dab${r.count === 1 ? "" : "s"}`),
          h("b", { class: "cond", style: "font-size:18px;color:var(--gold);width:44px;text-align:right" }, Jars.ratingText(r.avg))));
        card.append(list);
      }
    }
    if (dabs.length) {
      card.append(h("hr"));
      for (const d of dabs.slice(-10).reverse()) {
        const when = new Date(d.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toUpperCase().replace(",", " ·");
        const line = when + (d.peak !== undefined ? ` · PEAK ${d.peak}°` : "") + ` · ${d.seconds}S` + (d.grams !== undefined ? ` · ${d.grams.toFixed(2)}G` : "");
        card.append(h("div", { class: "row dabRow" },
          h("div", { style: "flex:1;min-width:0" }, h("b", { class: "cond", style: "font-size:18px" }, Dabs.goalText(d)),
            h("div", { class: "mono dim ellipsis", style: "font-size:9.5px" }, line),
            d.note ? h("div", { class: "mono sub", style: "font-size:10.5px" }, d.note) : null),
          d.rating === undefined
            ? h("button", { class: "rateKey", onclick: () => rateSheet({ jarID: j.id, dab: d }) }, "RATE IT")
            : h("b", { class: "cond", style: "font-size:22px;color:var(--gold)" }, Jars.ratingText(d.rating))));
      }
    }
    card.append(h("hr"));
    const mine = j.flavors ?? [];
    const fl = h("div", { class: "flavors" });
    for (const f of JarFlavor) {
      const on = mine.includes(f);
      fl.append(h("button", { class: "flavor" + (on ? " on" : ""), onclick: () => store.setFlavors(j.id, on ? mine.filter(x => x !== f) : [...mine, f]) }, f));
    }
    card.append(tag("FLAVOR", "font-size:8.5px"), fl);
    return card;
  }

  function priceCard(j: Jar): HTMLElement {
    const verdict = store.verdict(j);
    const card = h("div", { class: "panel pad stackS" }, h("div", { class: "row" }, tag("PRICE", "font-size:9.5px"), tag("ONLY YOU", "margin-left:auto;font-size:8.5px")));
    if (j.price === undefined) card.append(h("p", { class: "mono dim" }, "No price logged. Tap Edit to add what you paid."));
    else {
      const avg = Jars.avgDabGrams(j), n = Jars.sessionCount(j);
      card.append(h("div", { class: "cells" },
        cell("PAID", Jars.money(j.price), "var(--ink)", j.grams !== undefined ? Jars.gramsText(j.grams).toUpperCase() + " JAR" : undefined),
        cell("PER GRAM", Jars.money(Jars.perGram(j)), "var(--gold)"),
        cell(avg !== undefined ? "PER DAB" : "PER SESSION", Jars.money(Jars.perSession(j)), "var(--gold)",
          avg !== undefined ? `AVG ${avg.toFixed(2)} G` : n > 0 ? plural(n, "SESSION") : undefined)));
      card.append(h("div", { class: "row", style: "gap:10px" }, tag("WORTH IT?", "font-size:9px"),
        h("b", { class: "cond", style: `font-size:22px;letter-spacing:2px;color:${verdict === "PRICEY" ? "var(--warn)" : verdict ? "var(--live)" : "var(--dim)"}` }, verdict ?? "—")));
      if (!verdict) card.append(h("p", { class: "mono dim", style: "margin:0;font-size:10px" },
        j.rating === undefined || Jars.perGram(j) === undefined ? "Needs a rating, price and grams." : "Shows once 3 jars have a price, grams and a rating."));
      const left = Jars.gramsLeft(j);
      if (left !== undefined) card.append(h("p", { class: "mono sub", style: "margin:0" }, `About ${left.toFixed(2)} g left, by your logged dab sizes.`));
      if (j.shop) card.append(h("p", { class: "mono sub", style: "margin:0" }, `From ${j.shop} · ${new Date(Jars.boughtOn(j)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`));
    }
    card.append(h("hr"));
    const n = Jars.sessionCount(j);
    card.append(h("div", { class: "row", style: "gap:10px" },
      h("div", {}, tag("SESSIONS", "font-size:8.5px"), h("b", { class: "cond", style: "display:block;font-size:30px" }, String(n))),
      h("button", { class: "btn2", style: "margin-left:auto;width:52px", disabled: n === 0, onclick: () => store.logSession(j.id, -1) }, "−1"),
      h("button", { class: "goldKey", style: "width:96px", onclick: () => store.logSession(j.id, 1) }, "+1")));
    return card;
  }

  // MARK: Log a jar / Edit
  function editJar(original: Jar | null, onNew?: (id: string) => void, seed?: { strain: string; producer: string; category?: string; productID?: string; finished?: boolean }) {
    openSheet(close => {
      const st = {
        strain: original?.strain ?? seed?.strain ?? "", producer: original?.producer ?? seed?.producer ?? "", category: original?.category ?? seed?.category ?? null as string | null,
        extra: [] as { big: Blob; thumb: Blob; url: string }[], askAfter: false,
        review: original?.review ?? "", rating: original?.rating as number | undefined, finished: original?.finished ?? seed?.finished ?? false,
        price: original?.price !== undefined ? String(original.price) : "", grams: original?.grams as number | undefined,
        gramsText: original?.grams !== undefined && !GRAM_PICKS.includes(original.grams) ? String(original.grams) : "",
        shop: original?.shop ?? "", bought: new Date(original ? Jars.boughtOn(original) : Date.now()),
        change: { kind: "keep" } as PhotoChange, preview: undefined as string | null | undefined,
      };
      const body = h("div", { class: "pageBody" });
      let failed = false;
      const draw = () => body.replaceChildren(...editPage());
      const focusKeep = (fn: () => void) => { const a = document.activeElement as HTMLInputElement | null; const id = a?.id; const pos = a?.selectionStart; fn();
        if (id) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { el.focus(); try { if (pos !== null && pos !== undefined) el.setSelectionRange(pos, pos); } catch { /* fine */ } } } };

      const pickFile = h("input", { type: "file", accept: "image/*", hidden: true, onchange: (e: Event) => usePhoto(e) }) as HTMLInputElement;
      const snapFile = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: (e: Event) => usePhoto(e) }) as HTMLInputElement;
      const extraFile = h("input", { type: "file", accept: "image/*", hidden: true, onchange: (e: Event) => useExtra(e) }) as HTMLInputElement;
      async function useExtra(e: Event) {
        const input = e.target as HTMLInputElement;
        const f = input.files?.[0];
        input.value = "";
        if (!f || st.extra.length >= 2) return;
        try {
          const big = await cropPhoto(f);
          if (!big) return;
          st.extra.push({ big, thumb: await thumbFromBlob(big), url: URL.createObjectURL(big) });
        } catch { store.problem = "Couldn't read that photo. Try another one."; failed = true; }
        draw();
      }
      async function usePhoto(e: Event) {
        const input = e.target as HTMLInputElement;
        const f = input.files?.[0];
        input.value = "";
        if (!f) return;
        try {
          const big = await cropPhoto(f);
          if (!big) return;
          st.change = { kind: "replace", big, thumb: await thumbFromBlob(big) };
          if (st.preview) URL.revokeObjectURL(st.preview);
          st.preview = URL.createObjectURL(big);
        } catch { store.problem = "Couldn't read that photo. Try another one."; failed = true; }
        draw();
      }

      function editPage(): HTMLElement[] {
        const out: HTMLElement[] = [];
        out.push(topBar(textBtn("Cancel", () => { if (st.preview) URL.revokeObjectURL(st.preview); close(); }),
          h("div", { class: "center" }, tag(original ? "EDIT" : "NEW", "font-size:9.5px"), h("div", { class: "cond", style: "font-size:24px;letter-spacing:2px" }, original ? "EDIT JAR" : "LOG A JAR")), null));
        // Photo
        const hasPhoto = st.preview !== undefined ? st.preview !== null : !!original?.photo;
        out.push(jarPhoto(store, { photo: original?.photo, producer: st.producer }, "100%", 18, false, st.preview));
        out.push(h("div", { class: "row", style: "gap:8px" },
          h("button", { class: "photoKey", onclick: () => snapFile.click() }, icon("camera", "font-size:20px;margin-right:8px"), hasPhoto ? "RETAKE" : "SNAP IT"),
          h("button", { class: "photoKey", onclick: () => pickFile.click() }, icon("image", "font-size:20px;margin-right:8px"), "PICK"),
          hasPhoto ? h("button", { class: "photoKey", style: "flex:none;width:52px;color:var(--sub)", "aria-label": "Remove photo", onclick: () => {
            st.change = { kind: "remove" }; if (st.preview) URL.revokeObjectURL(st.preview); st.preview = null; draw(); } }, icon("close", "font-size:18px")) : null,
          pickFile, snapFile, extraFile));
        // New jars: two more photo slots after the cover (3 in all). Existing jars add photos on the jar page.
        if (!original) out.push(h("div", { class: "photoSlots" },
          h("div", { class: "slot cover" }, tag(hasPhoto ? "COVER ✓" : "COVER", "font-size:8.5px")),
          ...[0, 1].map(i => {
            const x = st.extra[i];
            return x ? h("div", { class: "slot", style: `background-image:url(${x.url})` },
                h("button", { class: "slotX", "aria-label": "Remove photo", onclick: () => { URL.revokeObjectURL(x.url); st.extra.splice(i, 1); draw(); } }, "×"))
              : h("button", { class: "slot add", "aria-label": "Add a photo", disabled: i > st.extra.length, onclick: () => extraFile.click() }, "+");
          })));
        out.push(field("STRAIN", "Orange Starburst", "edStrain", st.strain, v => { st.strain = v; focusKeep(draw); }));
        const prod = field("PRODUCER", "Pressure", "edProducer", st.producer, v => { st.producer = v; });
        const picks = store.knownProducers.slice(0, 6);
        if (picks.length) {
          const row = h("div", { class: "chips scrollX", style: "margin-top:8px" });
          for (const name of picks) row.append(h("button", { class: "chip gold" + (st.producer === name ? " on" : ""), onclick: () => { st.producer = name; draw(); } }, name.toUpperCase()));
          prod.append(row);
        }
        out.push(prod);
        // Type
        const cats = h("div", { class: "catGrid" });
        for (const c of JarCategory) cats.append(h("button", { class: "catKey" + (st.category === c ? " on" : ""), onclick: () => { st.category = st.category === c ? null : c; draw(); } }, c.toUpperCase()));
        out.push(h("div", {}, tag("TYPE", "font-size:9.5px"), cats));
        // Rating
        const rate = h("div", { class: "panel pad stackS center" },
          h("div", { class: "row" }, tag("RATE IT", "font-size:9.5px"), st.rating !== undefined ? h("button", { class: "textBtn", style: "margin-left:auto;font-size:16px", onclick: () => { st.rating = undefined; draw(); } }, "Clear") : null),
          h("div", { style: "display:flex;justify-content:center" }, ratingDial(st.rating, 150)));
        if (st.rating === undefined && !original && !st.finished) rate.append(h("button", { class: "btn2 wide askAfter" + (st.askAfter ? " on" : ""), "aria-pressed": String(st.askAfter),
          onclick: () => { st.askAfter = !st.askAfter; draw(); } }, st.askAfter ? "✓ ASK ME AFTER MY NEXT DAB" : "ASK ME AFTER MY NEXT DAB"));
        if (st.rating === undefined) rate.append(h("button", { class: "btn2 wide", style: "color:var(--gold)", onclick: () => { st.rating = 7; st.askAfter = false; draw(); } }, "TAP TO RATE"));
        else {
          rate.append(h("input", { type: "range", min: 0, max: 10, step: 0.1, value: String(st.rating), class: "gold",
            oninput: (e: Event) => { st.rating = Jars.clampRating(Number((e.target as HTMLInputElement).value)); updDial(); } }));
          const bump = (d: number) => () => { st.rating = Jars.clampRating((st.rating ?? 7) + d); draw(); };
          rate.append(h("div", { class: "row", style: "gap:8px" },
            ...([["−1", -1], ["−.1", -0.1], ["+.1", 0.1], ["+1", 1]] as [string, number][]).map(([l, d]) => h("button", { class: "step", style: "flex:1;color:var(--gold)", onclick: bump(d) }, l))));
        }
        const updDial = () => { const old = rate.querySelector(".dial"); if (old) old.replaceWith(ratingDial(st.rating, 150)); };
        out.push(rate);
        // Review
        const count = tag(`${st.review.length} / ${REVIEW_LIMIT}`, "margin-left:auto;font-size:9px");
        out.push(h("div", {}, h("div", { class: "row" }, tag("SAY IT", "font-size:9.5px"), count),
          h("textarea", { class: "panel textIn", rows: 5, maxlength: REVIEW_LIMIT, placeholder: "Taste, smell, how it hit, what temp.", value: st.review,
            oninput: (e: Event) => { st.review = (e.target as HTMLTextAreaElement).value.slice(0, REVIEW_LIMIT); count.textContent = `${st.review.length} / ${REVIEW_LIMIT}`; } })));
        // Price
        out.push(priceFields());
        if (original) out.push(h("label", { class: "panel switchRow pad" },
          h("span", {}, h("b", { class: "cond", style: "font-size:20px" }, "In the graveyard"), h("br"), h("small", { class: "mono dim" }, "Finished jars rest in the graveyard, ratings and all.")),
          h("input", { type: "checkbox", checked: st.finished, onchange: (e: Event) => { st.finished = (e.target as HTMLInputElement).checked; } })));
        if (failed && store.problem) out.push(h("p", { class: "mono", style: "color:var(--warn)" }, store.problem));
        const canSave = st.strain.trim() !== "";
        out.push(h("button", { class: "goldBtn big", disabled: !canSave, onclick: async () => {
          const base: Jar = original ? { ...original } : { id: uid(), strain: "", producer: "", review: "", finished: false, added: new Date().toISOString(), updated: new Date().toISOString() };
          const jar: Jar = { ...base, strain: st.strain, producer: st.producer, review: st.review, finished: st.finished };
          if (st.category) jar.category = st.category; else delete jar.category;
          if (st.rating !== undefined) jar.rating = st.rating; else delete jar.rating;
          if (!original && seed?.productID) jar.productID = seed.productID;
          if (!original && st.askAfter && st.rating === undefined) jar.askAfterDab = true;
          const price = Number(st.price.replace("$", "").replace(",", "."));
          if (st.price.trim() && price > 0) jar.price = price; else delete jar.price;
          if (st.grams !== undefined) jar.grams = st.grams; else delete jar.grams;
          jar.shop = st.shop;
          jar.bought = st.bought.toISOString();
          if (await store.save(jar, st.change)) {
            if (st.preview) URL.revokeObjectURL(st.preview);
            for (const x of st.extra) { await store.addPhoto(jar.id, x.big, x.thumb); URL.revokeObjectURL(x.url); }
            close();
            if (!original && jar.askAfterDab) store.setCurrent(jar.id);
            if (!original && onNew && !jar.finished) onNew(jar.id);
          } else { failed = true; draw(); }
        } }, original ? "SAVE IT" : "LOG IT"));
        if (!canSave) out.push(h("p", { class: "mono dim center", style: "font-size:10px;margin:0" }, "Name the strain to log it."));
        return out;
      }

      function priceFields(): HTMLElement {
        const pg = h("p", { class: "mono", style: "color:var(--gold);margin:0" });
        const updPg = () => { const p = Number(st.price.replace("$", "")); pg.textContent = p > 0 && st.grams ? `${Jars.money(p / st.grams)} per gram` : ""; };
        const keys = h("div", { class: "row", style: "gap:8px" });
        for (const g of GRAM_PICKS) keys.append(h("button", { class: "catKey" + (st.grams === g && !st.gramsText ? " on" : ""), style: "flex:1", onclick: () => { st.grams = g; st.gramsText = ""; draw(); } }, Jars.gramsText(g).toUpperCase()));
        const box = h("div", { class: "panel pad stackS" },
          h("div", { class: "row" }, tag("PRICE LOG", "font-size:9.5px"), tag("ONLY YOU", "margin-left:auto;font-size:8.5px")),
          h("div", { class: "row", style: "gap:10px" },
            h("label", { class: "panel inBox", style: "flex:1" }, h("span", { class: "dim" }, "$"),
              h("input", { id: "edPrice", inputmode: "decimal", placeholder: "35", value: st.price, oninput: (e: Event) => { st.price = (e.target as HTMLInputElement).value; updPg(); } })),
            h("label", { class: "panel inBox", style: "width:120px" },
              h("input", { id: "edGrams", inputmode: "decimal", placeholder: "Other", value: st.gramsText, oninput: (e: Event) => {
                const t = (e.target as HTMLInputElement).value; st.gramsText = t; const g = Number(t);
                if (g > 0) st.grams = g; else if (t) st.grams = undefined; updPg();
                keys.querySelectorAll(".catKey").forEach(k => k.classList.remove("on"));
              } }), h("span", { class: "dim" }, "g"))),
          keys, pg,
          h("input", { class: "panel textLine", placeholder: "Where you got it (optional)", value: st.shop, maxlength: 60, oninput: (e: Event) => { st.shop = (e.target as HTMLInputElement).value; } }),
          h("label", { class: "panel inBox", style: "justify-content:space-between" }, h("span", { class: "cond", style: "font-size:20px" }, "Bought"),
            h("input", { type: "date", value: dateValue(st.bought), max: dateValue(new Date()), onchange: (e: Event) => {
              const v = (e.target as HTMLInputElement).value; if (v) { const [y, m, d] = v.split("-").map(Number); st.bought = new Date(y, m - 1, d, 12); } } })));
        updPg();
        return box;
      }

      draw();
      return body;
    });
  }

  function field(label: string, hint: string, id: string, value: string, onInput: (v: string) => void): HTMLElement {
    return h("div", {}, tag(label, "font-size:9.5px"),
      h("input", { id, class: "panel textLine big", placeholder: hint, value, autocapitalize: "words", autocomplete: "off", spellcheck: false,
        oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) }));
  }

  // MARK: Spend
  function spendSheet() {
    openSheet(close => {
      const s = store.spend();
      const top = Math.max(0, ...s.byMonth.map(r => r[1]));
      const months = h("div", { class: "panel pad stackS" }, tag("LAST 12 MONTHS", "font-size:9.5px"));
      if (!s.byMonth.length) months.append(h("p", { class: "mono dim" }, "Nothing priced yet. Add what you paid when you log a jar."));
      for (const [m, v] of s.byMonth) months.append(h("div", { class: "row", style: "gap:10px" },
        h("span", { class: "mono sub", style: "width:78px" }, new Date(m).toLocaleDateString(undefined, { month: "short", year: "numeric" }).toUpperCase()),
        h("span", { class: "bar" }, h("i", { style: `width:${Math.max(4, top > 0 ? (v / top) * 100 : 0)}%` })),
        h("b", { class: "cond", style: "font-size:18px;width:70px;text-align:right" }, Jars.money(v))));
      return h("div", { class: "pageBody" },
        topBar(textBtn("Done", close), h("div", { class: "center" }, tag("ONLY YOU", "font-size:9.5px"), h("div", { class: "cond", style: "font-size:24px;letter-spacing:2px" }, "SPEND")), null),
        h("div", { class: "panel pad row" },
          h("div", {}, tag("ALL TIME", "font-size:8.5px"), h("b", { class: "cond", style: "display:block;font-size:30px" }, Jars.money(s.all)), tag(plural(s.pricedJars, "PRICED JAR"), "font-size:8px")),
          h("div", { style: "margin-left:auto;text-align:right" }, tag("AVG PER GRAM", "font-size:8.5px"), h("b", { class: "cond", style: "display:block;font-size:30px;color:var(--gold)" }, Jars.money(s.avgPerGram)))),
        months,
        h("p", { class: "mono dim center", style: "font-size:10px" }, "Prices never leave this phone."));
    });
  }

  // MARK: The rating pop-up (after a dab, or RATE IT in a jar's history)
  let promptOpen: { prompt: DabPrompt; close: () => void } | null = null;
  function renderPrompt() {
    const p = watcher.prompt;
    if (!p) { if (promptOpen) { promptOpen.close(); promptOpen = null; } return; }
    if (promptOpen?.prompt === p) return;
    promptOpen?.close();
    const jarID = p.jarID;
    const close = rateSheet(p, () => {
      promptOpen = null; watcher.close();
      const j = jarID ? store.jar(jarID) : undefined;
      if (j?.askAfterDab) askJarRating(j);
    });
    promptOpen = { prompt: p, close };
  }

  /** The one-time "rate this jar" card, after the first dab on a jar logged with Ask me after my next dab. */
  function askJarRating(j: Jar) {
    let r = j.rating ?? 7;
    const clear = () => { const x = store.jar(j.id); if (x) { const y = { ...x }; delete y.askAfterDab; void store.save(y, { kind: "keep" }); } };
    openSheet(close => {
      const dialBox = h("div", { style: "display:flex;justify-content:center" }, ratingDial(r, 140));
      return h("div", { class: "cardBody stackS center" },
        tag("RATE THE JAR", "font-size:9.5px"), h("h3", { style: "margin:0" }, j.strain), dialBox,
        h("input", { type: "range", min: 0, max: 10, step: 0.1, value: String(r), class: "gold",
          oninput: (e: Event) => { r = Jars.clampRating(Number((e.target as HTMLInputElement).value)); dialBox.replaceChildren(ratingDial(r, 140)); } }),
        h("div", { class: "row", style: "gap:10px" },
          h("button", { class: "btn2", style: "flex:1", onclick: () => { clear(); close(); } }, "NOT NOW"),
          h("button", { class: "goldBtn", style: "flex:1", onclick: () => {
            const x = store.jar(j.id); if (x) { const y = { ...x, rating: r }; delete y.askAfterDab; void store.save(y, { kind: "keep" }); }
            close(); } }, "SAVE")));
    }, "card");
  }

  function rateSheet(prompt: DabPrompt, onDone?: () => void): () => void {
    let closeFn = () => {};
    const closeAll = () => { closeFn(); onDone?.(); };
    closeFn = openSheet(() => {
      let picked: string | null = null;
      let keepCurrent = true;
      const jarIDf = () => prompt.jarID ?? picked;
      const jarf = () => store.jar(jarIDf());
      // Starting values: this dab's rating, else the last rating on this jar; size: this dab's, else the jar's last.
      const j0 = jarf();
      let rating = prompt.dab.rating ?? [...(j0?.dabs ?? [])].reverse().find(d => d.rating !== undefined)?.rating ?? 8;
      let sizePos = 1, sizeSet = false, sizeTouched = false;
      const g0 = prompt.dab.grams ?? (j0 ? Jars.lastDabGrams(j0) : undefined);
      if (g0 !== undefined) { sizePos = Dabs.positionFor(g0); sizeSet = true; }
      let noteOpen = false, note = "";
      let flavors: string[] = [];
      const card = h("div", { class: "cardBody rate" });

      const nudge = () => {
        const j = jarf();
        if (!j) return false;
        const n = (j.dabs ?? []).length + (prompt.jarID === null ? 1 : 0);
        return Dabs.flavorNudge(n, (j.flavors ?? []).length > 0);
      };
      const lastSame = () => {
        const j = jarf();
        if (!j) return undefined;
        const k = Dabs.groupKey(prompt.dab);
        const same = (j.dabs ?? []).filter(d => d.id !== prompt.dab.id && Dabs.groupKey(d) === k && d.rating !== undefined);
        return same.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.rating;
      };

      function finish(rate: boolean) {
        const r = rate ? Dabs.clamp(rating) : undefined;
        const n = note.trim();
        // Rated: save the size shown (a remembered default counts). Skipped: only a size actually set now.
        const size = sizeSet && (rate || sizeTouched) ? Dabs.gramsAt(sizePos) : undefined;
        if (prompt.jarID) {
          store.updateDab(prompt.jarID, prompt.dab.id, d => {
            d.asked = true;
            if (r !== undefined) d.rating = r;
            if (size !== undefined) d.grams = size; else if (rate || sizeTouched) delete d.grams;
            if (n) d.note = n;
          });
        } else if (picked) {
          const d: JarDab = { ...prompt.dab, asked: true };
          if (r !== undefined) d.rating = r;
          if (size !== undefined) d.grams = size;
          if (n) d.note = n;
          store.addDab(d, picked);
          if (keepCurrent) store.setCurrent(picked);
        }
        const id = jarIDf();
        if (id && flavors.length) store.setFlavors(id, flavors);
        if (rate) { try { navigator.vibrate?.([10, 40, 10]); } catch { /* fine */ } }
        closeAll();
      }

      function draw() {
        const j = jarf();
        const kids: Kid[] = [];
        kids.push(h("div", { class: "row" }, tag("HOW WAS THAT DAB?", "font-size:9.5px"),
          tag(`${Dabs.goalText(prompt.dab)}${prompt.dab.seconds > 0 ? ` · ${prompt.dab.seconds} S` : ""}`, "margin-left:auto;font-size:9px;color:var(--sub)")));
        if (j) kids.push(h("div", { class: "bigName", style: "font-size:28px" }, j.strain));
        if (prompt.jarID === null) {
          const open = store.shelf.filter(x => !x.finished);
          const strip = h("div", { class: "chips scrollX", style: "gap:10px" });
          for (const x of open) {
            strip.append(h("button", { class: "pickJar" + (picked === x.id ? " on" : ""), onclick: () => { picked = x.id; draw(); } },
              jarPhoto(store, x, "64px", 10), h("span", { class: "ellipsis" }, x.strain)));
          }
          kids.push(h("div", {}, tag("WHICH JAR WAS THAT?", "font-size:9.5px;color:var(--gold)"),
            open.length ? strip : h("p", { class: "mono dim" }, "No open jars yet. Log one in JARS."),
            picked ? h("label", { class: "switchRow" }, h("span", { class: "mono sub" }, "Log my next dabs to this jar"),
              h("input", { type: "checkbox", checked: keepCurrent, onchange: (e: Event) => { keepCurrent = (e.target as HTMLInputElement).checked; } })) : null));
        }
        const big = h("b", { class: "cond", style: "font-size:64px;line-height:1;color:var(--gold)" }, Jars.ratingText(rating));
        const last = lastSame();
        kids.push(h("div", { class: "row", style: "align-items:baseline" }, big, h("span", { class: "cond dim", style: "font-size:20px;margin-left:6px" }, "/ 10"),
          last !== undefined ? h("div", { style: "margin-left:auto;text-align:right" }, tag("LAST TIME AT " + Dabs.goalText(prompt.dab), "font-size:8px"),
            h("b", { class: "cond", style: "display:block;font-size:22px;color:var(--sub)" }, Jars.ratingText(last))) : null));
        const quick = h("div", { class: "row", style: "gap:8px" });
        const slider = h("input", { type: "range", min: 1, max: 10, step: 0.1, value: String(rating), class: "gold",
          oninput: (e: Event) => { rating = Dabs.clamp(Number((e.target as HTMLInputElement).value)); big.textContent = Jars.ratingText(rating);
            quick.querySelectorAll("button").forEach(b => b.classList.toggle("on", Number(b.textContent) === rating)); } });
        for (const v of [6, 7, 8, 9]) quick.append(h("button", { class: "quick" + (rating === v ? " on" : ""), onclick: () => { rating = v; draw(); } }, String(v)));
        kids.push(slider, quick);
        // Dab size
        const sizeLabel = sizeSet
          ? h("span", { class: "row", style: "margin-left:auto;gap:4px" }, h("b", { class: "cond", style: "font-size:16px;color:var(--gold)" }, Dabs.sizeText(Dabs.gramsAt(sizePos))),
              h("button", { class: "textBtn", "aria-label": "Clear dab size", style: "min-height:30px;min-width:30px", onclick: () => { sizeSet = false; draw(); } }, icon("close", "font-size:18px")))
          : tag("OPTIONAL", "margin-left:auto;font-size:8px");
        const stops = h("div", { class: "row", style: "gap:0" });
        SIZE_STOPS.forEach((s, i) => stops.append(h("button", { class: "stop" + (sizeSet && Math.abs(sizePos - i) < 0.001 ? " on" : ""),
          onclick: () => { sizePos = i; sizeSet = true; sizeTouched = true; draw(); } },
          h("b", {}, s.name), h("small", {}, (s.grams < 0.1 ? s.grams.toFixed(2) : s.grams.toFixed(1)) + "g"))));
        kids.push(h("div", {}, h("div", { class: "row" }, tag("DAB SIZE", "font-size:9px"), sizeLabel),
          h("input", { type: "range", min: 0, max: SIZE_STOPS.length - 1, step: 0.01, value: String(sizePos), class: sizeSet ? "gold" : "dimRange",
            onchange: (e: Event) => { sizePos = Dabs.snap(Number((e.target as HTMLInputElement).value)); sizeSet = true; sizeTouched = true; draw(); },
            oninput: (e: Event) => { sizePos = Dabs.snap(Number((e.target as HTMLInputElement).value)); sizeSet = true; sizeTouched = true;
              const b = card.querySelector(".sizeNow"); if (b) b.textContent = Dabs.sizeText(Dabs.gramsAt(sizePos)); } }),
          stops));
        const nd = nudge();
        if (nd) {
          const fl = h("div", { class: "flavors" });
          for (const f of JarFlavor) fl.append(h("button", { class: "flavor" + (flavors.includes(f) ? " on" : ""),
            onclick: () => { flavors = flavors.includes(f) ? flavors.filter(x => x !== f) : [...flavors, f]; draw(); } }, f));
          kids.push(h("div", {}, h("div", { class: "row" }, tag("GOT A READ ON THE FLAVOR?", "font-size:9px"), tag("OPTIONAL", "margin-left:auto;font-size:8px")), fl));
        }
        if (noteOpen || nd) kids.push(h("input", { class: "panel textLine", maxlength: 200, value: note,
          placeholder: nd ? "Flavor, smoothness, anything (optional)" : "A note on this dab", oninput: (e: Event) => { note = (e.target as HTMLInputElement).value; } }));
        else kids.push(h("button", { class: "textBtn", style: "align-self:flex-start;letter-spacing:1.5px", onclick: () => { noteOpen = true; draw(); } }, "+ NOTE"));
        kids.push(h("div", { class: "row", style: "gap:10px" },
          h("button", { class: "btn2", style: "width:96px;min-height:54px", onclick: () => finish(false) }, "Skip"),
          h("button", { class: "goldBtn", style: "flex:1;margin:0;min-height:54px", disabled: !jarIDf(), onclick: () => finish(true) }, "RATE IT")));
        card.replaceChildren(...kids.filter((k): k is Node | string => !!k));
        const sizeB = card.querySelector(".row b.cond[style*='16px']");
        if (sizeB) sizeB.classList.add("sizeNow");
      }
      draw();
      return card;
    }, "card");
    return closeAll;
  }


  // MARK: Account and GLOBAL (cloud.ts)

  function accountButton(): HTMLElement {
    const a = cloud!.account;
    const label = a.state === "ready" && a.profile ? a.profile.display_name : a.state === "needsProfile" ? "FINISH SIGN-IN" : "SIGN IN";
    return h("button", { class: "textBtn acctBtn", style: `margin-left:auto;color:${a.state === "ready" ? "var(--live)" : "var(--gold)"}`,
      "aria-label": "Account", onclick: openAccount }, (a.state === "ready" ? "● " : "") + label.toUpperCase());
  }

  function globalCard(j: Jar): HTMLElement {
    const a = cloud!.account;
    const count = j.globalCount ?? 0;
    const status = !CatalogKey.usable(j) ? "Add a producer to share this jar's rating."
      : a.state !== "ready" ? "Sign in to add your rating to GLOBAL."
      : j.shareRating === false ? "Your rating stays on this device."
      : j.rating === undefined ? "Rate this jar to add it to GLOBAL."
      : j.sentScore === j.rating && j.sentProductID ? "Your rating is in GLOBAL."
      : cloud!.sync.lastProblem ?? "Sending your rating…";
    const box = h("input", { type: "checkbox", checked: j.shareRating !== false,
      onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; void store.setServer(j.id, x => { if (v) delete x.shareRating; else x.shareRating = false; }); } });
    return h("div", { class: "panel pad stackS" },
      h("div", { class: "row" }, tag("GLOBAL", "font-size:9.5px"), j.globalScore !== undefined ? tag(count === 1 ? "1 RATING" : `${count} RATINGS`, "margin-left:auto;font-size:8.5px") : null),
      h("div", { class: "row", style: "align-items:baseline;gap:8px" },
        h("b", { class: "cond", style: `font-size:40px;color:${j.globalScore === undefined ? "var(--dim)" : "var(--live)"}` }, Jars.ratingText(j.globalScore)),
        h("span", { class: "cond dim", style: "font-size:18px" }, "/ 10")),
      j.globalScore === undefined ? h("p", { class: "mono dim", style: "margin:0" }, "No ratings from anyone yet.") : null,
      h("label", { class: "switchRow" }, h("b", { class: "cond", style: "font-size:20px;font-weight:500" }, "Share my rating"), box),
      h("p", { class: "mono sub", style: "margin:0" }, status),
      a.state !== "ready" ? h("button", { class: "btn2 wide", style: "color:var(--gold)", onclick: openAccount }, "SIGN IN") : null);
  }

  let accountRedraw: (() => void) | null = null;
  function openAccount(): void {
    if (!cloud) return;
    if (accountRedraw) { accountRedraw(); return; }
    const a = cloud.account;
    let name = a.profile?.display_name ?? "";
    let handle = a.profile?.ig_handle ?? "";
    let is21 = false;
    openSheet(close => {
      const page = h("div", { class: "pageBody" });
      const done = () => { accountRedraw = null; close(); };
      const draw = () => {
        const kids: (HTMLElement | null)[] = [topBar(textBtn("Done", done), h("span", { class: "tag" }, "ACCOUNT"), null)];
        if (a.state === "signedOut") {
          kids.push(h("h2", { style: "margin-top:20px" }, "Rate it for everyone."),
            h("p", { class: "sub" }, "Sign in to share your jar ratings and see the GLOBAL score on every jar. Only a jar's own rating is shared. Your photos, reviews, prices and dab history stay on this device."),
            h("p", { class: "mono", style: "color:var(--gold)" }, "21+ only."),
            h("button", { class: "bigBtn signIn", disabled: a.busy, onclick: () => void a.signIn("google") }, "Continue with Google"),
            h("button", { class: "bigBtn signIn", disabled: a.busy, onclick: () => void a.signIn("apple") }, "Continue with Apple"));
        } else if (a.state === "needsProfile") {
          const nameIn = h("input", { class: "textLine big", maxlength: 30, value: name, placeholder: "Display name", autocomplete: "nickname",
            oninput: (e: Event) => { name = (e.target as HTMLInputElement).value; } });
          const igIn = h("input", { class: "textLine", maxlength: 31, value: handle, placeholder: "@instagram (optional)", autocapitalize: "off",
            oninput: (e: Event) => { handle = (e.target as HTMLInputElement).value; } });
          kids.push(h("h2", { style: "margin-top:20px" }, "One more step: pick the name people see."),
            nameIn, igIn,
            h("label", { class: "switchRow" }, h("b", { class: "cond", style: "font-size:20px;font-weight:500" }, "I'm 21 or older"),
              h("input", { type: "checkbox", checked: is21, onchange: (e: Event) => { is21 = (e.target as HTMLInputElement).checked; } })),
            h("button", { class: "goldBtn big", disabled: a.busy, onclick: () => void a.saveProfile(name, handle, is21).then(ok => { if (ok) cloud.sync.kick(); }) }, "SAVE"),
            textBtn("Sign out", () => void a.signOut(), "var(--warn)"));
        } else {
          kids.push(h("h2", { style: "margin-top:20px" }, a.profile?.display_name ?? ""),
            a.profile?.ig_handle ? h("p", { class: "mono", style: "color:var(--live)" }, "@" + a.profile.ig_handle) : null,
            h("p", { class: "sub" }, "Your jar ratings count toward GLOBAL. Turn off Share my rating on any jar to keep it on this device. Your jars stay on this device."),
            h("button", { class: "btn2 wide", onclick: () => void a.signOut() }, "Sign out"),
            h("button", { class: "btn2 wide danger", style: "margin-top:24px", disabled: a.busy, onclick: () =>
              confirmSheet("Delete your account?", "This removes your sign-in, your name and every rating you shared. They drop out of GLOBAL right away. Your jars stay on this device. This can't be undone.",
                "Delete account", "Keep it", () => void a.deleteAccount(store)) }, "Delete account"));
        }
        if (a.problem) kids.push(h("div", { class: "problem" }, a.problem));
        kids.push(h("p", { class: "mono dim", style: "margin-top:24px;font-size:10px" }, "Privacy: torchlessapp.github.io/privacy"));
        page.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
      };
      accountRedraw = draw;
      draw();
      return page;
    });
  }

  return {
    renderHome,
    renderJars,
    renderOpen: () => { for (const f of openPages) f(); },
    renderPrompt,
    renderAccount: () => { accountRedraw?.(); },
    openAccount,
  };
}

function cell(title: string, value: string, color = "var(--ink)", note?: string): HTMLElement {
  return h("div", { class: "cell" }, tag(title, "font-size:8.5px"), h("b", { style: `color:${color}` }, value), note ? tag(note, "font-size:8px") : null);
}
function statusTag(finished: boolean): HTMLElement {
  return h("span", { class: "status" + (finished ? "" : " open") }, finished ? "GRAVEYARD" : "OPEN");
}
function dateValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function jarIcon(): Element {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "jarIcon");
  s.innerHTML = `<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>`;
  return s;
}
