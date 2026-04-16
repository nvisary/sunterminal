import { useEffect } from 'react';
import { TradingPage } from './pages/TradingPage';
import { wsClient } from './lib/ws-client';

export default function App() {
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+K: Emergency Exit
      if (e.ctrlKey && e.shiftKey && e.key === 'K') {
        e.preventDefault();
        if (confirm('EMERGENCY EXIT: Close ALL positions?')) {
          fetch('/api/hedge/emergency', { method: 'POST' });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      <TradingPage />
    </div>
  );
}
