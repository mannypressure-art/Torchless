// Full-screen mode transitions (front page -> rig Home, torch timer, jars). Display only.
// CONTRACT (do not change the signature): cover the screen, call swap() once while fully covered, reveal, resolve.

export type TransitionKind = "rig" | "torch" | "jars";

/** Plays the transition for `kind`. `swap` runs exactly once, while the screen is covered. `origin` is the tapped element (the motion may grow from it). */
export function playTransition(kind: TransitionKind, swap: () => void, origin?: HTMLElement | null): Promise<void> {
  void kind; void origin;
  swap();
  return Promise.resolve();
}
