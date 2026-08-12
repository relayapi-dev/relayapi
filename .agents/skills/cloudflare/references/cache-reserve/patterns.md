# Cache Reserve Patterns

## Best Practices

### 1. Always Enable Tiered Cache

```typescript
// Cache Reserve is designed for use WITH Tiered Cache
const configuration = {
  tieredCache: 'enabled',    // Required for optimal performance
  cacheReserve: 'enabled',   // Works best with Tiered Cache
  
  hierarchy: [
    'Lower-Tier Cache (visitor)',
    'Upper-Tier Cache (origin region)',
    'Cache Reserve (persistent)',
    'Origin'
  ]
};
```

### 2. Set Appropriate Cache-Control Headers

```typescript
// Origin response headers for Cache Reserve eligibility
const originHeaders = {
  'Cache-Control': 'public, max-age=86400', // 24hr (minimum 10hr)
  'Content-Length': '1024000', // Required
  'Cache-Tag': 'images,product-123', // Optional: purging
  'ETag': '"abc123"', // Optional: revalidation
  // Avoid: 'Set-Cookie' and 'Vary: *' prevent caching
};
```

### 3. Use Cache Rules for Fine-Grained Control

```typescript
// Different TTLs for different content types
const cacheRules = [
  {
    description: 'Long-term cache for immutable assets',
    expression: '(http.request.uri.path matches "^/static/.*\\.[a-f0-9]{8}\\.")',
    action_parameters: {
      cache_reserve: { eligible: true },
      edge_ttl: { mode: 'override_origin', default: 2592000 }, // 30 days
      cache: true
    }
  },
  {
    description: 'Moderate cache for regular images',
    expression: '(http.request.uri.path matches "\\.(jpg|png|webp)$")',
    action_parameters: {
      cache_reserve: { eligible: true },
      edge_ttl: { mode: 'override_origin', default: 86400 }, // 24 hours
      cache: true
    }
  },
  {
    description: 'Exclude API from Cache Reserve',
    expression: '(http.request.uri.path matches "^/api/")',
    action_parameters: { cache_reserve: { eligible: false }, cache: false }
  }
];
```

### 4. Making Assets Cache Reserve Eligible from Workers

**Note**: This modifies response headers to meet eligibility criteria but does NOT directly control Cache Reserve storage (which is zone-level automatic).

Prefer Cache Rules for known static paths. If a Worker must add headers, use a
strict static-asset allowlist and preserve every origin signal that makes a
response private. Never turn an authenticated or cookie-bearing response public,
and never remove `Set-Cookie`.

```typescript
const STATIC_CONTENT_TYPES = [
  'application/javascript',
  'font/',
  'image/',
  'text/css'
];

function isExplicitStaticAsset(url: URL): boolean {
  return url.pathname.startsWith('/static/') &&
    /\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$/i.test(url.pathname);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) ||
        !isExplicitStaticAsset(url) ||
        request.headers.has('Authorization') ||
        request.headers.has('Cookie')) {
      return fetch(request);
    }

    const response = await fetch(request);
    if (!response.ok || response.status !== 200) return response;
    
    const headers = new Headers(response.headers);
    const cacheControl = headers.get('Cache-Control') ?? '';
    const contentType = headers.get('Content-Type')?.toLowerCase() ?? '';
    if (headers.has('Set-Cookie') ||
        /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl) ||
        !headers.has('Content-Length') ||
        !STATIC_CONTENT_TYPES.some(type => contentType.startsWith(type))) {
      return response;
    }

    // Only supply a default when the explicitly static origin omitted policy.
    // Do not override an origin-selected shorter TTL.
    if (!cacheControl) headers.set('Cache-Control', 'public, max-age=36000');
    
    return new Response(response.body, { status: response.status, headers });
  }
};
```

### 5. Hostname Best Practices

Use Worker's hostname for efficient caching - avoid overriding hostname unnecessarily.

## Architecture Patterns

### Multi-Tier Caching + Immutable Assets

```typescript
// Optimal: L1 (visitor) → L2 (region) → L3 (Cache Reserve) → Origin
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isImmutable = url.pathname.startsWith('/static/') &&
      /\.[a-f0-9]{8,}\.(js|css|jpg|png|woff2)$/.test(url.pathname);
    const response = await fetch(request);

    const cacheControl = response.headers.get('Cache-Control') ?? '';
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (isImmutable &&
        ['GET', 'HEAD'].includes(request.method) &&
        !request.headers.has('Authorization') &&
        !request.headers.has('Cookie') &&
        response.status === 200 &&
        !response.headers.has('Set-Cookie') &&
        response.headers.has('Content-Length') &&
        STATIC_CONTENT_TYPES.some(type => contentType.startsWith(type)) &&
        !cacheControl) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  }
};
```

## Cost Optimization

### Cost Calculator

```typescript
interface CacheReserveEstimate {
  avgAssetSizeGB: number;
  uniqueAssets: number;
  monthlyReads: number;
  monthlyWrites: number;
  originEgressCostPerGB: number; // e.g., AWS: $0.09/GB
}

function estimateMonthlyCost(input: CacheReserveEstimate) {
  // Cache Reserve pricing
  const storageCostPerGBMonth = 0.015;
  const classAPerMillion = 4.50; // writes
  const classBPerMillion = 0.36; // reads
  
  // Calculate Cache Reserve costs
  const totalStorageGB = input.avgAssetSizeGB * input.uniqueAssets;
  const storageCost = totalStorageGB * storageCostPerGBMonth;
  const writeCost = (input.monthlyWrites / 1_000_000) * classAPerMillion;
  const readCost = (input.monthlyReads / 1_000_000) * classBPerMillion;
  
  const cacheReserveCost = storageCost + writeCost + readCost;
  
  // Calculate origin egress cost (what you'd pay without Cache Reserve)
  const totalTrafficGB = (input.monthlyReads * input.avgAssetSizeGB);
  const originEgressCost = totalTrafficGB * input.originEgressCostPerGB;
  
  // Savings calculation
  const savings = originEgressCost - cacheReserveCost;
  const savingsPercent = ((savings / originEgressCost) * 100).toFixed(1);
  
  return {
    cacheReserveCost: `$${cacheReserveCost.toFixed(2)}`,
    originEgressCost: `$${originEgressCost.toFixed(2)}`,
    monthlySavings: `$${savings.toFixed(2)}`,
    savingsPercent: `${savingsPercent}%`,
    breakdown: {
      storage: `$${storageCost.toFixed(2)}`,
      writes: `$${writeCost.toFixed(2)}`,
      reads: `$${readCost.toFixed(2)}`,
    }
  };
}

// Example: Media library
const mediaLibrary = estimateMonthlyCost({
  avgAssetSizeGB: 0.005, // 5MB images
  uniqueAssets: 10_000,
  monthlyReads: 5_000_000,
  monthlyWrites: 50_000,
  originEgressCostPerGB: 0.09, // AWS S3
});

console.log(mediaLibrary);
// {
//   cacheReserveCost: "$9.98",
//   originEgressCost: "$25.00",
//   monthlySavings: "$15.02",
//   savingsPercent: "60.1%",
//   breakdown: { storage: "$0.75", writes: "$0.23", reads: "$9.00" }
// }
```

### Optimization Guidelines

- **Set appropriate TTLs**: 10hr minimum, 24hr+ optimal for stable content, 30d max cautiously
- **Cache high-value stable assets**: Images, media, fonts, archives, documentation
- **Exclude frequently changing**: APIs, user-specific content, real-time data
- **Compression note**: Cache Reserve fetches uncompressed from origin, serves compressed to visitors - factor in origin egress costs

## See Also

- [README](./README.md) - Overview and core concepts
- [Configuration](./configuration.md) - Setup and Cache Rules
- [API Reference](./api.md) - Purging and monitoring
- [Gotchas](./gotchas.md) - Common issues and troubleshooting
