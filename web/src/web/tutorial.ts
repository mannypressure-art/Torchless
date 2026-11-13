// First-run how-to: four cards with Skip, dots and swipe. Shown once; replayable from the Rig tab.

import { h } from "./jar-ui";

const KEY = "torchless.tutorialSeen";
const CARDS: [string, string, string][] = [
  ["Meet Torchless.", "Connect your Switch and run it from your phone. Tap Heat it to start.", "var(--gold)"],
  ["Shape your ride.", "Tap a point on the chart, then + or − to tune temperature and time.", "var(--live)"],
  ["Keep your jars.", "Add photos, rate them, and borrow jars from the global shelf.", "var(--coll)"],
  ["Make it yours.", "Pick a Look and Lights in Style. You're set.", "var(--glob)"],
];

export function tutorialSeen(): boolean { try { return localStorage.getItem(KEY) === "yes"; } catch { return true; } }

export function showTutorial(): void {
  let at = 0;
  const root = h("div", { class: "tut", role: "dialog", "aria-modal": "true", "aria-label": "How Torchless works" });
  const done = () => { try { localStorage.setItem(KEY, "yes"); } catch { /* private mode */ } root.remove(); };
  const draw = () => {
    const [title, body, color] = CARDS[at];
    const last = at === CARDS.length - 1;
    root.replaceChildren(h("div", { class: "tutCard", style: `--tc:${color}` },
      h("div", { class: "row" }, h("span", { class: "tag", style: `color:${color}` }, `${at + 1} OF ${CARDS.length}`),
        h("button", { class: "textBtn", style: "margin-left:auto", onclick: done }, "Skip")),
      h("h2", { style: `color:${color}` }, title),
      h("p", {}, body),
      h("div", { class: "tutDots" }, ...CARDS.map((_, i) => h("button", { class: i === at ? "on" : "", "aria-label": `Card ${i + 1}`, onclick: () => { at = i; draw(); } }))),
      h("button", { class: "goldBtn big", onclick: () => { if (last) done(); else { at += 1; draw(); } } }, last ? "LET'S GO" : "NEXT")));
  };
  let sx: number | null = null;
  root.addEventListener("pointerdown", e => { sx = e.clientX; });
  root.addEventListener("pointerup", e => {
    if (sx === null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) < 50) return;
    at = Math.max(0, Math.min(CARDS.length - 1, at + (dx < 0 ? 1 : -1)));
    draw();
  });
  draw();
  document.body.append(root);
}
