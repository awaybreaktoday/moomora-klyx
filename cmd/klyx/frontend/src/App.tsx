import { useState, useEffect } from 'react'
import { Events, WML } from "@wailsio/runtime";
import { KlyxService } from "../bindings/github.com/moomora/klyx/cmd/klyx/index.js";

function App() {
  const [pingResult, setPingResult] = useState<string>('Waiting for round-trip...');
  const [pingEvent, setPingEvent] = useState<string>('Waiting for klyx:ping event...');

  useEffect(() => {
    // Prove the Go->JS event bridge works.
    Events.On('klyx:ping', (ev: any) => {
      setPingEvent(ev.data);
    });

    // Prove the JS->Go IPC call works.
    KlyxService.Ping().then((result: string) => {
      setPingResult(result);
    }).catch((err: any) => {
      setPingResult('Error: ' + String(err));
    });

    WML.Reload();
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', color: '#e0e0e0', background: '#0f141e', minHeight: '100vh' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Klyx</h1>
      <p style={{ color: '#8899aa', marginBottom: '2rem' }}>Platform-engineer-grade Kubernetes desktop client</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '480px' }}>
        <div style={{ background: '#1a2332', borderRadius: '8px', padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6688aa', marginBottom: '0.5rem' }}>
            JS to Go (IPC call)
          </div>
          <div style={{ fontFamily: 'monospace', color: '#4ade80' }}>{pingResult}</div>
        </div>

        <div style={{ background: '#1a2332', borderRadius: '8px', padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6688aa', marginBottom: '0.5rem' }}>
            Go to JS (event push)
          </div>
          <div style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{pingEvent}</div>
        </div>
      </div>
    </div>
  )
}

export default App
