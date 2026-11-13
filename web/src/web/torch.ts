// Torch mode: a heat-up and cool-down timer for people using a glass banger and a butane torch. No rig, no Bluetooth.
// CONTRACT (do not change the signatures): mountTorch renders into `root` and returns the handle below.

import { JarStore } from "./jars";
import { DabWatcher } from "./dab-watcher";

export interface TorchDeps {
  jars: JarStore;
  watcher: DabWatcher;
  prefs: { get(k: string): string | null; set(k: string, v: string): void };
  /** Ask the app to keep the screen awake (true) or let it sleep (false). */
  keepAwake(on: boolean): void;
  /** Open the Jars tab. */
  openJars(): void;
}

export interface TorchUI {
  /** The Torch tab became visible (true) or hidden (false). */
  setVisible(on: boolean): void;
  /** True while a heat-up or cool-down countdown is running. */
  readonly running: boolean;
  /** Redraw after jars changed (current jar strip). */
  renderJar(): void;
}

export function mountTorch(root: HTMLElement, deps: TorchDeps): TorchUI {
  void deps;
  root.textContent = "Torch mode";
  return { setVisible() {}, running: false, renderJar() {} };
}
