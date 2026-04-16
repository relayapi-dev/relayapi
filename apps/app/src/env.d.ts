/// <reference types="astro/client" />

declare module "cloudflare:workers" {
  const env: Record<string, any>;
  export { env };
}

declare namespace App {
  interface Locals {
    db: import("@relayapi/db").Database;
    auth: ReturnType<typeof import("@relayapi/auth").createAuth>;
    user: Record<string, unknown> | null;
    session: Record<string, unknown> | null;
    organization: Record<string, unknown> | null;
    debugPerf?: boolean;
    kv: {
      get: (key: string) => Promise<string | null>;
      put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
      delete: (key: string) => Promise<void>;
    };
  }
}
