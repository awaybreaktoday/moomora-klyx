import { useFleet, CRDGroupDTO, CRDCountDTO, crdCountKey } from "../store/fleet";
import { CRDService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listCRDs(cluster: string): Promise<void> {
  useFleet.getState().setCRDLoading(cluster);
  const groups = (await CRDService.ListCRDs(cluster)) as CRDGroupDTO[];
  useFleet.getState().setCRDs(cluster, groups ?? []);
}

// inFlight dedupes concurrent count requests for the same kind: re-renders can
// re-trigger a count before the first resolves, and we must not fan out
// redundant metadata lists (the whole point of the lazy/capped strategy on
// high-cardinality kinds like Cilium's).
const inFlight = new Set<string>();

export async function countKind(cluster: string, group: string, version: string, plural: string): Promise<void> {
  const key = crdCountKey(group, version, plural);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const c = (await CRDService.CountKind(cluster, group, version, plural)) as CRDCountDTO;
    useFleet.getState().setCRDCount(key, c);
  } finally {
    inFlight.delete(key);
  }
}
