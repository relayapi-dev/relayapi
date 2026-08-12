# TURN Implementation Patterns

Production-ready patterns for implementing Cloudflare TURN in WebRTC applications.

## Prerequisites

Before implementing these patterns, ensure you have:
- TURN key created: see [api.md#create-turn-key](./api.md#create-turn-key)
- Worker configured: see [configuration.md#cloudflare-worker-integration](./configuration.md#cloudflare-worker-integration)

## Basic TURN Configuration (Browser)

```typescript
interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password" | "oauth";
}

async function getTURNConfig(): Promise<RTCIceServer[]> {
  const response = await fetch('/api/turn-credentials', { method: 'POST' });
  if (!response.ok) throw new Error('Unable to get TURN credentials');
  const data = await response.json() as { iceServers: RTCIceServer[] };
  return data.iceServers;
}

// Use in RTCPeerConnection
const iceServers = await getTURNConfig();
const peerConnection = new RTCPeerConnection({ iceServers });
```

## Port Selection Strategy

Recommended order for browser clients:

1. **3478/udp** (primary, lowest latency)
2. **3478/tcp** (fallback for UDP-blocked networks)
3. **5349/tls** (corporate firewalls, most reliable)
4. **443/tls** (alternate TLS port, firewall-friendly)

**Avoid port 53**—blocked by Chrome and Firefox.

```typescript
function filterICEServersForBrowser(urls: string[]): string[] {
  return urls
    .filter(url => !/:53(?:\?|$)/.test(url))  // Remove port 53, but keep 5349
    .sort((a, b) => {
      // Prioritize UDP over TCP over TLS
      if (a.includes('transport=udp')) return -1;
      if (b.includes('transport=udp')) return 1;
      if (a.includes('transport=tcp') && !a.startsWith('turns:')) return -1;
      if (b.includes('transport=tcp') && !b.startsWith('turns:')) return 1;
      return 0;
    });
}
```

## Credential Refresh (Mid-Session)

When credentials expire during long calls:

```typescript
async function refreshTURNCredentials(pc: RTCPeerConnection): Promise<void> {
  const response = await fetch('/api/turn-credentials', { method: 'POST' });
  if (!response.ok) throw new Error('Unable to refresh TURN credentials');
  const newCreds = await response.json() as { iceServers: RTCIceServer[] };
  const config = pc.getConfiguration();
  config.iceServers = newCreds.iceServers;
  pc.setConfiguration(config);
  // Note: setConfiguration() does NOT trigger ICE restart
  // Combine with restartIce() if connection fails
}

// Auto-refresh before expiry
setInterval(async () => {
  await refreshTURNCredentials(peerConnection);
}, 3000000);  // 50 minutes if TTL is 1 hour
```

## ICE Restart Pattern

After network change, TURN server maintenance, or credential expiry:

```typescript
pc.addEventListener('iceconnectionstatechange', async () => {
  if (pc.iceConnectionState === 'failed') {
    console.warn('ICE connection failed, restarting...');
    
    // Refresh credentials
    await refreshTURNCredentials(pc);
    
    // Trigger ICE restart
    pc.restartIce();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    
    // Send offer to peer via signaling channel...
  }
});
```

## Credentials Caching Pattern

```typescript
class TURNCredentialsManager {
  private creds: { iceServers: RTCIceServer[]; expiresAt: number } | null = null;

  async getCredentials(keyId: string, keySecret: string): Promise<RTCIceServer[]> {
    const now = Date.now();
    
    if (this.creds && this.creds.expiresAt > now) {
      return this.creds.iceServers;
    }

    const ttl = 3600;
    if (ttl > 172800) throw new Error('TTL max 48hrs');

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${keySecret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl })
      }
    );

    if (!res.ok) throw new Error(`TURN credential generation failed: ${res.status}`);
    const data = await res.json() as { iceServers: RTCIceServer[] };
    const iceServers = data.iceServers.map(server => ({
      ...server,
      urls: Array.isArray(server.urls)
        ? server.urls.filter(url => !/:53(?:\?|$)/.test(url))
        : server.urls
    }));

    this.creds = {
      iceServers,
      expiresAt: now + (ttl * 1000) - 60000
    };

    return this.creds.iceServers;
  }
}
```

## Common Use Cases

```typescript
// Video conferencing: TURN as fallback
const config = { iceServers: await getTURNConfig(), iceTransportPolicy: 'all' };

// IoT/predictable connectivity: force TURN
const config = { iceServers: await getTURNConfig(), iceTransportPolicy: 'relay' };

// Screen sharing: reduce overhead
const pc = new RTCPeerConnection({ iceServers: await getTURNConfig(), bundlePolicy: 'max-bundle' });
```

## Integration with Cloudflare Calls SFU

```typescript
// TURN is automatically used when needed
// Cloudflare Calls handles TURN + SFU coordination
const session = await callsClient.createSession({
  appId: 'your-app-id',
  sessionId: 'meeting-123'
});
```

## Debugging ICE Connectivity

```typescript
pc.addEventListener('icecandidate', (event) => {
  if (event.candidate) {
    console.log('ICE candidate:', event.candidate.type, event.candidate.protocol);
  }
});

pc.addEventListener('iceconnectionstatechange', () => {
  console.log('ICE state:', pc.iceConnectionState);
});

// Check selected candidate pair
const stats = await pc.getStats();
stats.forEach(report => {
  if (report.type === 'candidate-pair' && report.selected) {
    console.log('Selected:', report);
  }
});
```

## See Also

- [api.md](./api.md) - Credential generation API, types
- [configuration.md](./configuration.md) - Worker setup, environment variables
- [gotchas.md](./gotchas.md) - Common mistakes, troubleshooting
