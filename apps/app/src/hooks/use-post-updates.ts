import { useEffect, useRef } from "react";

export interface RealtimeEvent {
  type: string; // e.g. "post.updated", "inbox.comment.received", "notification.created"
  post_id?: string;
  status?: string;
  comment_id?: string;
  conversation_id?: string;
  platform?: string;
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Singleton WebSocket connection manager
// Multiple useRealtimeUpdates hooks share one WebSocket connection.
// The connection opens when the first subscriber mounts and closes
// when the last subscriber unmounts.
// ---------------------------------------------------------------------------

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let connecting = false;
let wsInfo: { url: string; token: string } | null = null;

function broadcast(event: RealtimeEvent) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* ignore */ }
  }
}

function cleanupWs() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws = null;
  }
}

function scheduleReconnect() {
  if (listeners.size === 0) return;
  const delay = Math.min(1000 * 2 ** attempt, 30_000);
  attempt++;
  // If wsInfo isn't loaded yet, retry the full flow; otherwise just reconnect the WS
  reconnectTimeout = setTimeout(wsInfo ? connectWs : () => ensureConnection(), delay);
}

function connectWs() {
  if (listeners.size === 0 || !wsInfo) return;

  ws = new WebSocket(`${wsInfo.url}?token=${encodeURIComponent(wsInfo.token)}`);

  ws.onopen = () => {
    attempt = 0;
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30_000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as RealtimeEvent;
      if (data.type && data.type !== "pong") {
        broadcast(data);
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    cleanupWs();
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose fires after onerror */ };
}

async function ensureConnection() {
  if (ws || connecting) return;
  connecting = true;
  try {
    if (!wsInfo) {
      const res = await fetch("/api/ws-info");
      if (!res.ok) {
        // Retry after backoff — the auth session may not be ready yet
        scheduleReconnect();
        return;
      }
      wsInfo = await res.json();
    }
    if (wsInfo && listeners.size > 0) connectWs();
  } catch {
    // Network error — retry after backoff
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  ensureConnection();
}

function unsubscribe(listener: Listener) {
  listeners.delete(listener);
  if (listeners.size === 0) {
    // No more subscribers — tear down the connection
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    // Null handlers BEFORE close to prevent onclose from triggering reconnect
    const socket = ws;
    cleanupWs();
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    attempt = 0;
  }
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to real-time dashboard events via WebSocket.
 * Multiple components can call this hook — they all share one WebSocket connection.
 */
export function useRealtimeUpdates(onEvent: (event: RealtimeEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const listener: Listener = (event) => onEventRef.current(event);
    subscribe(listener);
    return () => unsubscribe(listener);
  }, []);
}

/** @deprecated Use useRealtimeUpdates instead */
export const usePostUpdates = useRealtimeUpdates;
