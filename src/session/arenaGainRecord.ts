/**
 * What a session records about the sensitivity its arena actually applied
 * (Pass 15, requirement I).
 *
 * ## Why this exists
 *
 * Builds up to and including rc.8 moved the reticle one logical pixel per
 * mouse count for every candidate. A calibration run on such a build is a
 * real session with real trials and a real recommendation — and the
 * recommendation is not evidence about sensitivity, because the player never
 * felt the sensitivities being compared.
 *
 * Those sessions are kept. Deleting them would destroy provenance, and the
 * raw trials remain perfectly good records of what happened. But they must
 * never be read back as if they were the same kind of evidence as a session
 * where the candidates genuinely differed, so the distinction is written down
 * rather than inferred:
 *
 *   - a session with `arenaGain.modelVersion === ARENA_GAIN_MODEL_VERSION`
 *     applied per-candidate gain and its recommendation is about sensitivity;
 *   - a session with NO `arenaGain` field predates the fix, and its
 *     recommendation is about everything except sensitivity.
 *
 * Absence is the marker. That is deliberate: no historical file is rewritten,
 * and a build that cannot read this field still reads the session.
 */

import type { CandidateId } from "../domain/ids.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";

export const SESSION_ARENA_GAIN_RECORD_VERSION = 1 as const;

/** One candidate's applied gain, revealed with the rest of the blinding. */
export interface AppliedCandidateGain {
  readonly candidateId: string;
  readonly sensX: number;
  readonly sensY: number;
  /** Logical arena px per raw mouse count actually applied for this candidate. */
  readonly pxPerCountX: number;
  readonly pxPerCountY: number;
  /** Player-facing presentation of the same physical sensitivity. */
  readonly cmPer360X: number;
}

export interface SessionArenaGainRecord {
  readonly recordVersion: typeof SESSION_ARENA_GAIN_RECORD_VERSION;
  /** The arena physical model in force. See src/sensmath/arenaGain.ts. */
  readonly modelVersion: string;
  readonly anchorSource: string;
  /** One sentence naming where the physical anchor came from. */
  readonly anchorBasis: string;
  readonly referenceSensX: number;
  readonly referenceSensY: number;
  readonly referenceDegreesPerCmX: number;
  readonly referenceDegreesPerCmY: number;
  readonly pxPerDegree: number;
  readonly dpi: number;
  /** Every candidate the arena was configured for, with what it applied. */
  readonly appliedGains: readonly AppliedCandidateGain[];
  /**
   * Largest ratio between any two candidates' applied gain. Exactly 1 means
   * every candidate felt identical — the rc.8 defect — so a reader can detect
   * a regression from the record alone, without re-deriving anything.
   */
  readonly gainSpreadRatio: number;
}

export interface ArenaGainRecordInput {
  modelVersion: string;
  anchorSource: string;
  anchorBasis: string;
  referenceSensX: number;
  referenceSensY: number;
  referenceDegreesPerCmX: number;
  referenceDegreesPerCmY: number;
  pxPerDegree: number;
  dpi: number;
  candidates: readonly {
    id: CandidateId | string;
    sensitivity: SensitivityConfiguration;
    gain: { x: number; y: number };
    cmPer360X: number;
  }[];
}

export function buildSessionArenaGainRecord(
  input: ArenaGainRecordInput,
): SessionArenaGainRecord {
  const appliedGains: AppliedCandidateGain[] = input.candidates.map((c) => ({
    candidateId: String(c.id),
    sensX: c.sensitivity.sensX,
    sensY: c.sensitivity.sensY,
    pxPerCountX: c.gain.x,
    pxPerCountY: c.gain.y,
    cmPer360X: c.cmPer360X,
  }));
  const xs = appliedGains.map((g) => g.pxPerCountX).filter((v) => v > 0);
  const spread = xs.length > 0 ? Math.max(...xs) / Math.min(...xs) : 1;
  return {
    recordVersion: SESSION_ARENA_GAIN_RECORD_VERSION,
    modelVersion: input.modelVersion,
    anchorSource: input.anchorSource,
    anchorBasis: input.anchorBasis,
    referenceSensX: input.referenceSensX,
    referenceSensY: input.referenceSensY,
    referenceDegreesPerCmX: input.referenceDegreesPerCmX,
    referenceDegreesPerCmY: input.referenceDegreesPerCmY,
    pxPerDegree: input.pxPerDegree,
    dpi: input.dpi,
    appliedGains,
    gainSpreadRatio: spread,
  };
}

/**
 * Reads a possibly-absent, possibly-ancient arena-gain record off a persisted
 * session. Returns null for anything unrecognised — an unreadable gain record
 * must never make a historical session unreadable, and null is exactly the
 * answer "this session did not apply candidate gain" anyway.
 */
export function readSessionArenaGainRecord(
  raw: unknown,
): SessionArenaGainRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SessionArenaGainRecord>;
  if (r.recordVersion !== SESSION_ARENA_GAIN_RECORD_VERSION) return null;
  if (typeof r.modelVersion !== "string" || r.modelVersion.length === 0) return null;
  if (!Array.isArray(r.appliedGains)) return null;
  return r as SessionArenaGainRecord;
}

/**
 * Whether a persisted session genuinely exposed the player to different
 * candidate sensitivities.
 *
 * Two ways to fail: no record at all (a pre-fix build), or a record whose
 * candidates all came out at the same gain (which the current model cannot
 * produce for a real ladder, but which a future regression could).
 */
export function sessionAppliedCandidateGain(
  record: SessionArenaGainRecord | null,
): boolean {
  if (!record) return false;
  return record.gainSpreadRatio > 1 + 1e-9;
}

/** The warning a pre-fix session's recommendation must be shown with. */
export const PRE_GAIN_SESSION_WARNING =
  "This session ran on a build whose arena moved the crosshair the same distance for every sensitivity it was comparing, so its recommended sensitivity is not evidence about sensitivity. The drills themselves are unaffected and are kept in full.";
