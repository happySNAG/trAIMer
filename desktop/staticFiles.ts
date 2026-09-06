/**
 * Pure static-file rules for the desktop shell's `aldo://` frontend delivery.
 *
 * Deliberately dependency-free (node:path only, no Electron) so the security
 * rules that used to live inside the PowerShell launcher are now directly
 * unit-testable on any host — see tests/desktopShell.test.ts.
 */
import { join, normalize, resolve, sep, extname } from "node:path";

/** Static MIME allowlist. Unknown extensions are refused, never guessed. */
export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
});

/**
 * Content-Security-Policy applied to every frontend response.
 *
 * `connect-src` is limited to the loopback capture helper: the product makes
 * no other network calls, ever (scripts/audit-no-telemetry.mjs enforces the
 * source-level half of the same promise).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Resolves a request path inside `root`.
 *
 * Returns null for anything that escapes the root, contains a NUL, uses a
 * Windows separator, or cannot be percent-decoded. Fails closed by design.
 */
export function resolveWithinRoot(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Backslashes are path separators on Windows; refuse them outright rather
  // than letting normalize() reinterpret them.
  if (decoded.includes("\\")) return null;
  if (decoded === "" || decoded === "/") decoded = "/index.html";
  if (!decoded.startsWith("/")) return null;
  // Refuse ".." outright rather than relying on normalize() to collapse it:
  // a request that tries to climb is a bug or an attack, never a real asset.
  if (decoded.split("/").some((segment) => segment === "..")) return null;
  const rootResolved = resolve(root);
  const candidate = resolve(join(rootResolved, normalize(decoded)));
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }
  return candidate;
}

/** Looks up the allowlisted MIME type for a path, or null when unknown. */
export function mimeTypeFor(filePath: string): string | null {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? null;
}
