// The rig adapter: the read-only shape every screen reads, whichever rig is linked.
// RigController (Dr. Dabber Switch 2) has it already; PeakController (Puffco Peak Pro) maps its own state into it
// (temps in °F, profiles 1 to 4 as presets 1 to 4). Readers that only use this shape (the gauge, the jar dab
// log, the heat-up look) work for both rigs. Writes stay rig-specific: each controller has its own commands.

import type { LiveStatus } from "./frames";
import type { PresetInfo } from "./rig-controller";

export interface RigReadView {
  readonly live: LiveStatus | null;
  readonly presets: PresetInfo[];
  readonly sessionOn: boolean;
  readonly linkFresh: boolean;
  readonly connected: boolean;
}

/** The heat controls the Home screen needs, for either rig. */
export interface RigHeatControls {
  readonly canHeat: boolean;
  heatIt(): void;
  cutIt(): void;
}
