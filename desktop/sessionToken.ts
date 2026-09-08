/**
 * Per-launch capture session token.
 *
 * Minted fresh in memory on every launch and handed to exactly two places:
 * the helper (as `--token`) and the renderer (over the context bridge). It
 * is never written to disk, never logged, and never leaves the machine — it
 * only stops two local Aim Lab processes from cross-talking.
 */
import { randomBytes } from "node:crypto";

/** 32 lowercase hex chars — the shape the helper handshake validates. */
export function mintSessionToken(): string {
  return randomBytes(16).toString("hex");
}

export const SESSION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
