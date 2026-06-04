import { useEffect } from "react";
import { FleetView } from "./fleet/FleetView";
import { useTheme } from "./theme/ThemeProvider";
import { initFleetBridge } from "./bridge/fleet";

export default function App() {
  const { theme, toggle } = useTheme();
  useEffect(() => {
    let off = () => {};
    initFleetBridge()
      .then((u) => (off = u))
      .catch((e) => console.error("bridge init", e));
    return () => off();
  }, []);
  return (
    <div>
      <button onClick={toggle} style={{ position: "fixed", top: 12, right: 12 }}>
        theme: {theme}
      </button>
      <FleetView />
    </div>
  );
}
