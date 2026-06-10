import { useEffect } from "react";
import { AppShell } from "./app/AppShell";
import { initFleetBridge } from "./bridge/fleet";
import { initForwardsBridge } from "./bridge/forwards";

export default function App() {
  useEffect(() => {
    let offFleet = () => {};
    let offForwards = () => {};
    initFleetBridge().then((u) => (offFleet = u)).catch((e) => console.error("fleet bridge init", e));
    initForwardsBridge().then((u) => (offForwards = u)).catch((e) => console.error("forwards bridge init", e));
    return () => { offFleet(); offForwards(); };
  }, []);
  return <AppShell />;
}
