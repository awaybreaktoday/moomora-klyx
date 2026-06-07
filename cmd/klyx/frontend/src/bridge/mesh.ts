import { useFleet, MeshGraphDTO } from "../store/fleet";
import { MeshService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function getMeshGraph(): Promise<void> {
  const g = (await MeshService.GetMeshGraph()) as MeshGraphDTO;
  useFleet.getState().setMesh(g ?? { nodes: [], edges: [] });
}
