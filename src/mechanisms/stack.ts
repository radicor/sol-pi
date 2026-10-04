import { Harness, HarnessOptions, Mechanism } from "../core/harness.js";
import { ActionFusion } from "./action-fusion.js";
import { EvidencePreservingReducer } from "./evidence-reducer.js";
import { ObservationPack } from "./observation-pack.js";
import { OnlineContextCompact } from "./online-compact.js";

export const FOUR_MECHANISMS = [
  "ActionFusion",
  "OnlineContextCompact",
  "EvidencePreservingReducer",
  "ObservationPack",
] as const;

export type MechanismName = (typeof FOUR_MECHANISMS)[number];

export const MECHANISM_NAMES: MechanismName[] = [...FOUR_MECHANISMS];

export interface SolPiConfig {
  mechanisms: MechanismName[];
  actionFusion?: { allowReadDependent?: boolean };
  observationPack?: {
    thresholdBytes?: number;
    excerptBytes?: number;
    fullForRequests?: number;
  };
  reducer?: {
    thresholdBytes?: number;
    maxReceiptBytes?: number;
    extractorFidelity?: number;
  };
  onlineCompact?: {
    contextWindow?: number;
    cacheWriteReadRatio?: number;
    laterCompactionMargin?: number;
    windowLimitFraction?: number;
    compactTargetFraction?: number;
    maxCompactions?: number;
  };
}

export function buildMechanisms(config: SolPiConfig): Mechanism[] {
  const out: Mechanism[] = [];
  if (config.mechanisms.includes("ActionFusion")) out.push(new ActionFusion(config.actionFusion));
  if (config.mechanisms.includes("EvidencePreservingReducer"))
    out.push(new EvidencePreservingReducer(config.reducer));
  if (config.mechanisms.includes("ObservationPack")) out.push(new ObservationPack(config.observationPack));
  if (config.mechanisms.includes("OnlineContextCompact"))
    out.push(new OnlineContextCompact({ contextWindow: 200_000, ...config.onlineCompact }));
  return out;
}

export interface SolPiHarnessOptions extends Omit<HarnessOptions, "mechanisms"> {
  config?: SolPiConfig;
}

export class SolPiHarness extends Harness {
  constructor(opts: SolPiHarnessOptions) {
    const config = opts.config ?? { mechanisms: [...MECHANISM_NAMES] };
    super({ ...opts, mechanisms: buildMechanisms(config) });
  }
}

export { ActionFusion, EvidencePreservingReducer, ObservationPack, OnlineContextCompact };
