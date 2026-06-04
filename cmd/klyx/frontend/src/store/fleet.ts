import { create } from "zustand";

export type ClusterDTO = {
  name: string;
  state: string;
  reason: string;
  nodesReady: number;
  nodesTotal: number;
  pods: number;
  version: string;
  gitopsTier: string;
  gitopsReason: string;
  networkTier: string;
  networkReason: string;
  env: string;
  region: string;
  provider: string;
  group: string;
  ageSeconds: number;
};

type FleetState = {
  clusters: ClusterDTO[];
  setClusters: (c: ClusterDTO[]) => void;
};

export const useFleet = create<FleetState>((set) => ({
  clusters: [],
  setClusters: (clusters) => set({ clusters }),
}));
