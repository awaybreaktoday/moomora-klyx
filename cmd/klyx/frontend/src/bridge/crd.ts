import { useFleet, CRDGroupDTO, CRDCountDTO, crdCountKey, ResourceRef, InstanceDTO } from "../store/fleet";
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

type InstancePageDTO = { items: InstanceDTO[]; nextToken: string };

export async function loadInstances(cluster: string, ref: ResourceRef, token?: string): Promise<void> {
  if (!token) useFleet.getState().setInstancesLoading(ref);
  const page = (await CRDService.ListInstances(cluster, ref.group, ref.version, ref.plural, token ?? "")) as InstancePageDTO;
  // Drop a stale page if the user navigated to a different kind meanwhile.
  const cur = useFleet.getState().instances.ref;
  if (!cur || cur.group !== ref.group || cur.plural !== ref.plural) return;
  // First page REPLACES (idempotent against StrictMode's double effect invoke and
  // any re-trigger); only "load more" (token set) appends.
  if (token) useFleet.getState().addInstancePage(page.items ?? [], page.nextToken ?? "");
  else useFleet.getState().setInstancePage(page.items ?? [], page.nextToken ?? "");
}
