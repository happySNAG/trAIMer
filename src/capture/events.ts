import type { Vec2 } from "../domain/geometry.ts";
import type { TargetId } from "../domain/ids.ts";
import type { TargetSpan } from "../domain/trial.ts";

export type PointerMotionEvent = {
  kind: "pointer-sample";
  tMs: number;
  dx: number;
  dy: number;
};

export type ButtonEvent = {
  kind: "button";
  tMs: number;
  action: "press" | "release";
};

export type TargetSpawnEvent = {
  kind: "target-spawn";
  tMs: number;
  targetId: TargetId;
  radiusPx: number;
  motion: TargetSpan["motion"];
};

export type TargetRemoveEvent = {
  kind: "target-remove";
  tMs: number;
  targetId: TargetId;
  reason: "hit" | "expired" | "trial-end";
};

export type FocusChangeEvent = {
  kind: "focus-change";
  tMs: number;
  focused: boolean;
  reason: string;
};

export type LockChangeEvent = {
  kind: "lock-change";
  tMs: number;
  locked: boolean;
  reason: string;
};

export type ResizeEvent = {
  kind: "resize";
  tMs: number;
  widthPx: number;
  heightPx: number;
};

export type CaptureEvent =
  | PointerMotionEvent
  | ButtonEvent
  | TargetSpawnEvent
  | TargetRemoveEvent
  | FocusChangeEvent
  | LockChangeEvent
  | ResizeEvent;

export const CAPTURE_SOURCE_KINDS = [
  "synthetic",
  "browser-pointer-lock",
  "native",
] as const;

export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];

export const POINTER_LOCK_LOSS_REASON = "pointer-lock-loss";
export const TAB_HIDDEN_REASON = "tab-hidden";
export const WINDOW_BLUR_REASON = "window-blur";
export const USER_ABORT_REASON = "user-abort";

export interface CaptureSourceDescriptor {
  kind: CaptureSourceKind;
  description: string;
  nominalSampleIntervalMs: number | null;
}

export interface CaptureSink {
  onEvent(event: CaptureEvent): void;
}

export interface CaptureSource {
  readonly descriptor: CaptureSourceDescriptor;
  start(sink: CaptureSink): void;
  stop(): void;
}

export function initialReticlePosition(viewport: {
  widthPx: number;
  heightPx: number;
}): Vec2 {
  return { x: viewport.widthPx / 2, y: viewport.heightPx / 2 };
}
