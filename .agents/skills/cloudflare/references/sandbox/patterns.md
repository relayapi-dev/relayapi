# Common Patterns

## AI Code Execution with Code Context

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { code, variables } = await request.json();
    const sandbox = getSandbox(env.Sandbox, 'ai-agent');
    
    // Create context with persistent variables
    const ctx = await sandbox.createCodeContext({
      language: 'python',
      variables: variables || {}
    });
    
    // Execute with rich outputs (text, images, HTML)
    const result = await sandbox.runCode(code, { context: ctx });
    
    return Response.json({
      results: result.results,  // RichOutput[] (text, html, png, json, etc.)
      error: result.error,
      success: !result.error
    });
  }
};
```

## Interactive Dev Environment

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;
    
    const sandbox = getSandbox(env.Sandbox, 'ide', { normalizeId: true });
    
    if (request.url.endsWith('/start')) {
      await sandbox.exec('curl -fsSL https://code-server.dev/install.sh | sh');
      await sandbox.startProcess('code-server --bind-addr 0.0.0.0:8080', {
        processId: 'vscode'
      });
      
      const exposed = await sandbox.exposePort(8080);
      return Response.json({ url: exposed.url });
    }
    
    return new Response('Try /start');
  }
};
```

## WebSocket Real-Time Service

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const sandbox = getSandbox(env.Sandbox, 'realtime-service');
      return await sandbox.wsConnect(request, 8080);
    }

    // Non-WebSocket: expose preview URL
    const sandbox = getSandbox(env.Sandbox, 'realtime-service');
    const { url } = await sandbox.exposePort(8080, {
      hostname: new URL(request.url).hostname
    });
    return Response.json({ wsUrl: url.replace('https', 'wss') });
  }
};
```

**Dockerfile**:
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0
RUN npm install -g ws
EXPOSE 8080
```

## Process Readiness Pattern

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.Sandbox, 'app-server');
    
    // Start server
    const process = await sandbox.startProcess(
      'node server.js',
      { processId: 'server' }
    );
    
    // Wait for server to be ready
    await process.waitForPort(8080);  // Wait for port listening
    
    // Now safe to expose
    const { url } = await sandbox.exposePort(8080);
    return Response.json({ url });
  }
};
```

## Persistent Data with Bucket Mounting

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.Sandbox, 'data-processor');
    
    // Mount R2 bucket (production only)
    await sandbox.mountBucket(env.DATA_BUCKET, '/data', {
      readOnly: false
    });
    
    // Process files in bucket
    const result = await sandbox.exec('python3 /workspace/process.py', {
      env: { DATA_DIR: '/data/input' }
    });
    
    // Results written to /data/output are persisted in R2
    return Response.json({ success: result.success });
  }
};
```

## CI/CD Pipeline

Authenticate the caller first, strictly validate repository inputs, and keep the
shell command constant. Shell-quoting untrusted interpolation is not sufficient.

```typescript
type Principal = { tenantId: string; userId: string; canRunCi: boolean };

// Implement with your application's established session/JWT verifier. It must
// verify integrity, issuer, audience, expiry, and revocation before returning.
declare function authenticateRequest(request: Request, env: Env): Promise<Principal | null>;

function parseGitHubRepository(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.exec(value);
  return match ? value : null;
}

function parseGitBranch(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(value) &&
    !value.startsWith('-') && !value.includes('..') ? value : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const principal = await authenticateRequest(request, env);
    if (!principal) return new Response('Unauthorized', { status: 401 });
    if (!principal.canRunCi) return new Response('Forbidden', { status: 403 });

    const input = await request.json() as { repo?: unknown; branch?: unknown };
    const repository = parseGitHubRepository(input.repo);
    const branch = parseGitBranch(input.branch);
    if (!repository || !branch) return new Response('Invalid repository input', { status: 400 });

    // The caller does not control this ID. Each job receives a separate sandbox.
    const sandbox = getSandbox(env.Sandbox, `ci-${crypto.randomUUID()}`);
    try {
      await sandbox.exec(
        'git clone --depth=1 --branch "$GIT_BRANCH" -- "$GIT_REPOSITORY" /workspace/repo',
        { env: { GIT_BRANCH: branch, GIT_REPOSITORY: repository } }
      );

      const install = await sandbox.exec('npm ci', { cwd: '/workspace/repo' });
      if (!install.success) {
        return Response.json({ success: false, error: 'Install failed' });
      }

      const test = await sandbox.exec('npm test', { cwd: '/workspace/repo' });
      return Response.json({
        success: test.success,
        output: test.stdout,
        exitCode: test.exitCode
      });
    } finally {
      await sandbox.destroy();
    }
  }
};
```





## Multi-Tenant Pattern

Sessions inside one sandbox share filesystem, process, and network access. Use a
separate sandbox as the tenant boundary, derive identity from verified server-side
authentication, and execute user code from a file instead of interpolating it.

```typescript
async function tenantSandboxId(tenantId: string, userId: string): Promise<string> {
  const identity = JSON.stringify([tenantId, userId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `user-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const principal = await authenticateRequest(request, env);
    if (!principal) return new Response('Unauthorized', { status: 401 });

    const code = await request.text();
    if (new TextEncoder().encode(code).byteLength > 64 * 1024) {
      return new Response('Program too large', { status: 413 });
    }

    const sandbox = getSandbox(
      env.Sandbox,
      await tenantSandboxId(principal.tenantId, principal.userId)
    );
    await sandbox.writeFile('/workspace/user_code.py', code);
    const result = await sandbox.exec('python3 /workspace/user_code.py', {
      timeout: 30_000
    });

    return Response.json({ output: result.stdout });
  }
};
```

## Git Operations

```typescript
// Clone repo
await sandbox.exec('git clone https://github.com/user/repo.git /workspace/repo');

// Private repositories: use an authenticated proxy or a credential helper with
// a short-lived, job-scoped token. Never put a token in the clone URL or argv.
const token = await issueShortLivedGitToken(principal, 'user/repo');
// This helper writes a mode-0700 GIT_ASKPASS program without logging the token.
// Keep its implementation in trusted application code, not caller-controlled input.
await configureGitCredentialHelper(sandbox, token);
await sandbox.exec('git clone https://github.com/user/repo.git /workspace/repo', {
  env: { GIT_ASKPASS: '/workspace/git-askpass.sh', GIT_JOB_TOKEN: token }
});
```
