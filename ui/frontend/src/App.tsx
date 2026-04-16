import { useEffect, useState } from 'react';
import { TradingPage } from './pages/TradingPage';
import { LogsPage } from './pages/LogsPage';
import { wsClient } from './lib/ws-client';

type Page = 'trading' | 'logs';

export default function App() {
  const [page, setPage] = useState<Page>('trading');

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
      // Ctrl+L: Toggle logs
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        setPage((p) => p === 'trading' ? 'logs' : 'trading');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      {page === 'trading' && <TradingPage onOpenLogs={() => setPage('logs')} />}
      {page === 'logs' && <LogsPage onBack={() => setPage('trading')} />}
    </div>
  );
}
