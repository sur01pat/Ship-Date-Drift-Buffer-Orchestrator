import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:4000/ws';

// Upgrade ws:// → wss:// automatically when the page is served over HTTPS
// to avoid mixed-content blocks
const RESOLVED_WS_URL = typeof window !== 'undefined' && window.location.protocol === 'https:'
  ? WS_URL.replace(/^ws:\/\//, 'wss://')
  : WS_URL;

export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(RESOLVED_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          onMessage(msg);
        } catch (_) {}
      };
    } catch (_) {}
  }, [onMessage]);

  useEffect(() => {
    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [connect]);

  return connected;
}
