// Stand-alone page for Torch mode (test only, not shipped). Built and driven by test/torch-check.js.
// Mounts mountTorch with an in-memory jar store and the app's real rating pop-up.
import { JarStore, MemoryJarBackend, Jar } from "../src/web/jars";
import { DabWatcher } from "../src/web/dab-watcher";
import { mountJars } from "../src/web/jar-ui";
import { heatSound } from "../src/web/heatfx";
import { mountTorch } from "../src/web/torch";

const q = new URLSearchParams(location.search);
const prefs = {
  get(k: string): string | null { try { return localStorage.getItem("torchless." + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem("torchless." + k, v); } catch { /* fine */ } },
};
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme")!;
if (q.get("sound")) prefs.set("heatSound", q.get("sound")!);

(async () => {
  const store = new JarStore(new MemoryJarBackend());
  await store.load();
  if (q.get("jar") !== "0") {
    const jar: Jar = { id: "jar1", strain: "Papaya Bomb", producer: "Hash House", review: "", finished: false, added: new Date().toISOString() };
    await store.save(jar);
    store.setCurrent("jar1");
  }
  const watcher = new DabWatcher(store);
  const jarUI = mountJars(store, watcher, () => {});
  const log: string[] = [];
  const torch = mountTorch(document.getElementById("torchPanel")!, {
    jars: store, watcher, prefs,
    keepAwake: on => { log.push("awake:" + on); },
    openJars: () => { log.push("openJars"); },
  });
  watcher.onPrompt = () => { log.push("prompt:" + (watcher.prompt ? watcher.prompt.jarID : "closed")); jarUI.renderPrompt(); };
  store.onChange = () => { torch.renderJar(); };
  for (const ev of ["pointerdown", "pointerup", "touchend", "click"]) document.addEventListener(ev, () => heatSound.unlock(), { capture: true, passive: true });
  (window as unknown as Record<string, unknown>).T = { torch, store, watcher, log, prefs };
  document.body.dataset.ready = "1";
})();
