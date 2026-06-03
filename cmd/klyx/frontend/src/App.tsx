import { FleetView } from "./fleet/FleetView";
import { useTheme } from "./theme/ThemeProvider";

export default function App() {
  const { theme, toggle } = useTheme();
  return (
    <div>
      <button onClick={toggle} style={{ position: "fixed", top: 12, right: 12 }}>theme: {theme}</button>
      <FleetView />
    </div>
  );
}
