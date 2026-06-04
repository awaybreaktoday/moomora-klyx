import { useFleet, CRDGroupDTO, CRDCountDTO, crdCountKey } from "../store/fleet";
import { CRDService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listCRDs(cluster: string): Promise<void> {
  useFleet.getState().setCRDLoading(cluster);
  const groups = (await CRDService.ListCRDs(cluster)) as CRDGroupDTO[];
  useFleet.getState().setCRDs(cluster, groups ?? []);
}

export async function countKind(cluster: string, group: string, version: string, plural: string): Promise<void> {
  const c = (await CRDService.CountKind(cluster, group, version, plural)) as CRDCountDTO;
  useFleet.getState().setCRDCount(crdCountKey(group, version, plural), c);
}
