/**
 * Local static frontend delivery over the privileged `aldo://` scheme.
 *
 * Replaces the old loopback PowerShell HttpListener entirely: no TCP socket,
 * no port negotiation, no firewall prompt, and — critically — a STABLE
 * origin, so IndexedDB training history survives every relaunch and upgrade.
 *
 * Security posture (mirrors the retired launcher's guarantees):
 *   - GET only.
 *   - Traversal-guarded: the resolved path must stay inside the frontend root.
 *   - Strict MIME allowlist; unknown extensions are refused, never guessed.
 *   - A restrictive CSP is attached to every response.
 */
import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { APP_HOST, APP_SCHEME } from "./config";
import {
  CONTENT_SECURITY_POLICY,
  mimeTypeFor,
  resolveWithinRoot,
} from "./staticFiles";
import type { DesktopLog } from "./logging";

/**
 * Must run BEFORE `app.whenReady()`.
 *
 * `standard` gives the scheme a real origin (IndexedDB/localStorage work),
 * `secure` makes it a potentially-trustworthy context (Pointer Lock works),
 * and `corsEnabled` is required alongside `supportFetchAPI` so same-origin
 * policy is actually enforced for the scheme.
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: false,
      },
    },
  ]);
}

/** Installs the `aldo://` handler. Must run AFTER `app.whenReady()`. */
export function registerFrontendProtocol(root: string, log: DesktopLog): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (url.hostname !== APP_HOST) {
      return new Response("not found", { status: 404 });
    }
    const filePath = resolveWithinRoot(root, url.pathname);
    if (filePath === null) {
      log.warn("frontend-path-refused", { path: url.pathname });
      return new Response("forbidden", { status: 403 });
    }
    const mime = mimeTypeFor(filePath);
    if (mime === null) {
      log.warn("frontend-mime-refused", { path: url.pathname });
      return new Response("unsupported media type", { status: 415 });
    }
    try {
      const body = await readFile(filePath);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "content-type": mime,
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
