/**
 * Reads an environment variable in a runtime-agnostic way.
 *
 * Checks in order:
 *   1. Node.js / Bun / Cloudflare Workers  — globalThis.process.env
 *   2. Deno                                 — Deno.env.get()
 *
 * Does NOT import `node:process` or any Node-specific modules so this file
 * is safe to bundle for Workers and Deno without any polyfill.
 */
export function readEnv(key: string): string | undefined {
  // Node.js, Bun, Cloudflare Workers (process.env is shimmed in Workers)
  const proc = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  if (proc?.env) {
    const val = proc.env[key];
    if (val !== undefined) return val;
  }

  // Deno
  const deno = (
    globalThis as unknown as {
      Deno?: { env?: { get?: (k: string) => string | undefined } };
    }
  ).Deno;
  if (typeof deno?.env?.get === 'function') {
    try {
      return deno.env.get(key);
    } catch {
      // Throws when --no-allow-env is passed; treat as not-set
    }
  }

  return undefined;
}
