// Test page for transition.ts. Build and run: node test/transition/run.js (it bundles this with esbuild).
import { playTransition, CLIPS, TransitionKind } from "../../src/web/transition";

const $ = (id: string) => document.getElementById(id)!;
const state = { swaps: 0, resolved: 0, bright: new URLSearchParams(location.search).get("to") === "light", log: [] as string[],
  cover: [] as (number | string)[], throwInSwap: false };

/** Lowest alpha (0-255) of the transition canvas over a 6x10 grid, read at the moment of the swap. */
function coverAlpha(): number | string {
  const c = document.querySelector<HTMLCanvasElement>(".tx-canvas");
  if (!c) { const v = document.querySelector<HTMLVideoElement>(".tx-video"); return v ? `video@${(v.currentTime / v.duration).toFixed(2)}` : `overlay opacity ${document.querySelector<HTMLElement>(".tx-overlay")?.style.opacity ?? "none"}`; }
  const x = c.getContext("2d")!;
  let min = 255;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 10; j++)
    min = Math.min(min, x.getImageData(Math.floor((i + 0.5) / 6 * c.width), Math.floor((j + 0.5) / 10 * c.height), 1, 1).data[3]);
  return min;
}

function show(kind: TransitionKind | null) {
  $("front").hidden = kind !== null;
  $("next").hidden = kind === null;
  document.documentElement.dataset.theme = kind !== null && state.bright ? "light" : "dark";
  if (kind) { $("nextBig").textContent = kind.toUpperCase(); $("nextTag").textContent = state.bright ? "bright page" : "dark page"; $("count").textContent = String(state.swaps); }
  window.scrollTo(0, 0);
}

function play(kind: TransitionKind, origin?: HTMLElement | null): Promise<void> {
  const t0 = performance.now();
  return playTransition(kind, () => {
    state.swaps++; state.log.push(`swap ${kind} ${Math.round(performance.now() - t0)}`);
    state.cover.push(coverAlpha());
    if (state.throwInSwap) { state.throwInSwap = false; throw new Error("swap blew up (on purpose)"); }
    show(kind);
  }, origin)
    .then(() => { state.resolved++; state.log.push(`done ${kind} ${Math.round(performance.now() - t0)}`); $("status").textContent = `${kind} ${Math.round(performance.now() - t0)} ms`; });
}

document.querySelectorAll<HTMLElement>(".card").forEach(b => b.addEventListener("click", () => void play(b.dataset.kind as TransitionKind, b)));
$("toDark").addEventListener("click", () => { state.bright = false; $("status").textContent = "next: dark"; });
$("toLight").addEventListener("click", () => { state.bright = true; $("status").textContent = "next: bright"; });
$("back").addEventListener("click", () => show(null));

Object.assign(window, { __tx: { state, play, show, CLIPS, playTransition } });
