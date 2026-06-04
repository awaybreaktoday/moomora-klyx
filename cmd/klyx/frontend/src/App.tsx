import { useEffect } from "react";
import { AppShell } from "./app/AppShell";
import { initFleetBridge } from "./bridge/fleet";

export default function App() {
  useEffect(() => {
    let off = () => {};
    initFleetBridge().then((u) => (off = u)).catch((e) => console.error("bridge init", e));
    return () => off();
  }, []);
  return <AppShell />;
}
