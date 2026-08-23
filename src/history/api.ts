import type { LocalJsonStore } from "../persistence/store.ts";
import type { Recommendation } from "../domain/recommendation.ts";

/**
 * Stable, UI-independent History API (Pass 4, requirement M).
 *
 * Returns typed view models ONLY — no DOM types, no chart code. A future UI
 * (or Claude Code's redesign) can render these directly; the calculations
 * live here and must not be forked into presentation code.
 */

export interface SessionSummaryViewModel {
  experimentId: string;
  sessionId: string | null;
  startedAtIso: string | null;
  endedAtIso: string | null;
  playerName: string | null;
  dpi: number | null;
  measuredTrials: number;
  invalidTrials: number;
  recommendedEdpi: number | null;
  confidence: number | null;
  edpiRange: { min: number; max: number } | null;
  unresolvedBoundary: boolean | null;
  captureQualityScore: number | null;
  captureSourceKind: string | null;
  optimizerVersion: string | null;
  appVersion: string | null;
  retestOfExperimentId: string | null;
}

export interface TrendPoint {
  experimentId: string;
  atIso: string;
  value: number | null;
}

export interface HistoryTrends {
  xSensPercent: TrendPoint[];
  ySensPercent: TrendPoint[];
  edpi: TrendPoint[];
  eDpiTrendIsSameAsEdpi: true;
  confidence: TrendPoint[];
  captureQualityScore: TrendPoint[];
}

export interface CandidateRankingRow {
  candidateId: string;
  edpiX: number;
  rank: number;
  utilityMean: number | null;
  utilitySe: number | null;
  validTrials: number;
  tiedWithBest: boolean;
}

export interface RankingHistoryEntry {
  experimentId: string;
  atIso: string;
  rows: CandidateRankingRow[];
}

export interface DimensionTrendEntry {
  experimentId: string;
  atIso: string;
  dimensions: Record<string, { mean: number; standardError: number }>;
}

export interface CalibrationHistoryEntry {
  recordPath: string;
  axis: "x" | "y";
  createdAtIso: string;
  adequate: boolean;
  degreesPerCountAt100: number | null;
  dpi: number | null;
  method: string;
}

export interface RetestLineageEdge {
  priorExperimentId: string;
  retestExperimentId: string;
  retestSessionId: string | null;
}

export interface DeviceHistoryEntry {
  sessionId: string;
  userAgent: string;
  platform: string;
  screenPx: { width: number; height: number };
  pointerCoalescingSupported: boolean | null;
}

export interface OptimizerVersionHistoryEntry {
  experimentId: string;
  optimizerVersion: string | null;
}

export interface HistorySnapshot {
  sessions: SessionSummaryViewModel[];
  trends: HistoryTrends;
  rankingHistory: RankingHistoryEntry[];
  dimensionTrend: DimensionTrendEntry[];
  calibrationHistory: CalibrationHistoryEntry[];
  retestLineage: RetestLineageEdge[];
  deviceHistory: DeviceHistoryEntry[];
  optimizerVersions: OptimizerVersionHistoryEntry[];
}

const HUMAN_SESSIONS_DIR = "human-sessions";
const RECOMMENDATIONS_DIR = "recommendations";
const CALIBRATIONS_DIR = "calibrations";

interface HumanSessionLike {
  sessionId: string;
  experimentId: string;
  displayName?: string;
  playerId?: string;
  dpi?: number;
  startedAtIso: string;
  endedAtIso: string | null;
  measuredCount?: number;
  invalidTrialCount?: number;
  device?: {
    userAgent?: string;
    platform?: string;
    screenPx?: { width: number; height: number };
    pointerCoalescingSupported?: boolean | null;
  };
  recommendationEdpi?: number | null;
  recommendationConfidence?: number | null;
  optimizerVersion?: string;
  retestOfExperimentId?: string | null;
}

/**
 * Reads every persisted artifact once and derives all views from it. For the
 * data volumes of a local-first app (hundreds of sessions) this is fine and
 * keeps the API trivially cacheable.
 */
export class HistoryApi {
  constructor(private readonly store: LocalJsonStore) {}

  async listSessions(): Promise<SessionSummaryViewModel[]> {
    const paths = await this.store.listByPrefix(HUMAN_SESSIONS_DIR);
    const out: SessionSummaryViewModel[] = [];
    for (const p of paths) {
      const raw = await this.store.loadRawAt<unknown>("human-session", p);
      const hs = raw?.payload as HumanSessionLike | undefined;
      if (!hs || typeof hs.experimentId !== "string") continue;
      out.push(await this.sessionSummary(hs));
    }
    // Also include experiments that have a recommendation but no human session
    // (e.g. imported bundles or CLI runs).
    const known = new Set(out.map((s) => s.experimentId));
    const recPaths = await this.store.listByPrefix(RECOMMENDATIONS_DIR);
    for (const p of recPaths) {
      const experimentId = p.slice(RECOMMENDATIONS_DIR.length + 1, -".json".length);
      if (known.has(experimentId)) continue;
      const rec = await this.store.loadRecommendation(experimentId);
      if (!rec) continue;
      const trials = await this.store.loadAllTrials(experimentId);
      out.push({
        experimentId,
        sessionId: null,
        startedAtIso: null,
        endedAtIso: null,
        playerName: null,
        dpi: null,
        measuredTrials: trials.filter((t) => t.phase === "measured").length,
        invalidTrials: trials.filter((t) => t.validity?.status !== "valid").length,
        recommendedEdpi: rec.recommendedEdpi ?? null,
        confidence: rec.confidence ?? null,
        edpiRange: rec.edpiRange ? { ...rec.edpiRange } : null,
        unresolvedBoundary: rec.unresolvedBoundary ?? null,
        captureQualityScore: null,
        captureSourceKind: null,
        optimizerVersion: null,
        appVersion: null,
        retestOfExperimentId: null,
      });
    }
    return out.sort(
      (a, b) =>
        new Date(b.startedAtIso ?? b.experimentId).getTime() -
        new Date(a.startedAtIso ?? a.experimentId).getTime(),
    );
  }

  async sessionSummary(hs: HumanSessionLike): Promise<SessionSummaryViewModel> {
    const rec = await this.store.loadRecommendation(hs.experimentId);
    const quality = rec?.inputQuality ?? null;
    return {
      experimentId: hs.experimentId,
      sessionId: hs.sessionId ?? null,
      startedAtIso: hs.startedAtIso ?? null,
      endedAtIso: hs.endedAtIso ?? null,
      playerName: hs.displayName ?? hs.playerId ?? null,
      dpi: hs.dpi ?? null,
      measuredTrials: hs.measuredCount ?? 0,
      invalidTrials: hs.invalidTrialCount ?? 0,
      recommendedEdpi: rec?.recommendedEdpi ?? hs.recommendationEdpi ?? null,
      confidence: rec?.confidence ?? hs.recommendationConfidence ?? null,
      edpiRange: rec?.edpiRange ? { ...rec.edpiRange } : null,
      unresolvedBoundary: rec?.unresolvedBoundary ?? null,
      captureQualityScore:
        rec && "inputQuality" in rec && quality ? quality.score : null,
      captureSourceKind: null,
      optimizerVersion: hs.optimizerVersion ?? null,
      appVersion: null,
      retestOfExperimentId: hs.retestOfExperimentId ?? null,
    };
  }

  async trends(): Promise<HistoryTrends> {
    const sessions = await this.listSessions();
    const point = (
      s: SessionSummaryViewModel,
      value: number | null,
    ): TrendPoint => ({
      experimentId: s.experimentId,
      atIso: s.startedAtIso ?? s.experimentId,
      value,
    });
    // sensX/sensY come from recommendations (primarySensitivity).
    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const rec = await this.store.loadRecommendation(s.experimentId);
        return { s, rec };
      }),
    );
    return {
      xSensPercent: enriched.map(({ s, rec }) =>
        point(s, rec?.primarySensitivity.sensX ?? null),
      ),
      ySensPercent: enriched.map(({ s, rec }) =>
        point(s, rec?.primarySensitivity.sensY ?? null),
      ),
      edpi: sessions.map((s) => point(s, s.recommendedEdpi)),
      eDpiTrendIsSameAsEdpi: true,
      confidence: sessions.map((s) => point(s, s.confidence)),
      captureQualityScore: sessions.map((s) => point(s, s.captureQualityScore)),
    };
  }

  async rankingHistory(): Promise<RankingHistoryEntry[]> {
    const sessions = await this.listSessions();
    const out: RankingHistoryEntry[] = [];
    for (const s of sessions) {
      const rec: Recommendation | null =
        await this.store.loadRecommendation(s.experimentId);
      if (!rec) continue;
      const rows: CandidateRankingRow[] = Object.entries(
        rec.evidence.validTrialsPerCandidate,
      )
        .map(([candidateId, validTrials]) => ({
          candidateId,
          edpiX: Math.round(rec.edpiRange.min),
          rank: Number.MAX_SAFE_INTEGER,
          utilityMean: null,
          utilitySe: null,
          validTrials,
          tiedWithBest: false,
        }))
        .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
      const bestId = rec.evidence.bestCandidateId;
      const bestIdx = rows.findIndex((r) => r.candidateId === bestId);
      if (bestIdx >= 0) rows[bestIdx]!.rank = 1;
      else if (rows[0]) rows[0].rank = 1;
      let nextRank = 2;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.rank === Number.MAX_SAFE_INTEGER) {
          rows[i]!.rank = nextRank++;
        }
      }
      if (bestId === rows[rows.length - 1]?.candidateId && rows.length > 1) {
        // best listed last still ranks 1
        rows[rows.length - 1]!.rank = 1;
      }
      out.push({
        experimentId: s.experimentId,
        atIso: s.startedAtIso ?? s.experimentId,
        rows,
      });
    }
    return out;
  }

  async dimensionTrend(): Promise<DimensionTrendEntry[]> {
    const sessions = await this.listSessions();
    const out: DimensionTrendEntry[] = [];
    for (const s of sessions) {
      const rec = await this.store.loadRecommendation(s.experimentId);
      if (!rec?.dimensionEstimates) continue;
      const dims: DimensionTrendEntry["dimensions"] = {};
      for (const [dim, est] of Object.entries(rec.dimensionEstimates)) {
        if (!est) continue;
        dims[dim] = { mean: est.mean, standardError: est.standardError };
      }
      out.push({
        experimentId: s.experimentId,
        atIso: s.startedAtIso ?? s.experimentId,
        dimensions: dims,
      });
    }
    return out;
  }

  async calibrationHistory(): Promise<CalibrationHistoryEntry[]> {
    const paths = await this.store.listByPrefix(CALIBRATIONS_DIR);
    const out: CalibrationHistoryEntry[] = [];
    for (const p of paths) {
      const raw = await this.store.loadRawAt<unknown>("calibration-record", p);
      const rec = raw?.payload as
        | {
            axis?: string;
            createdAtIso?: string;
            adequate?: boolean;
            degreesPerCountAt100?: number | null;
            method?: string;
            measurements?: { dpi?: number }[];
          }
        | undefined;
      if (!rec) continue;
      out.push({
        recordPath: p,
        axis: rec.axis === "y" ? "y" : "x",
        createdAtIso: rec.createdAtIso ?? "",
        adequate: rec.adequate ?? false,
        degreesPerCountAt100: rec.degreesPerCountAt100 ?? null,
        dpi: rec.measurements?.[0]?.dpi ?? null,
        method: rec.method ?? "unknown",
      });
    }
    return out.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async retestLineage(): Promise<RetestLineageEdge[]> {
    const sessions = await this.listSessions();
    return sessions
      .filter((s) => s.retestOfExperimentId)
      .map((s) => ({
        priorExperimentId: s.retestOfExperimentId!,
        retestExperimentId: s.experimentId,
        retestSessionId: s.sessionId,
      }));
  }

  async deviceHistory(): Promise<DeviceHistoryEntry[]> {
    const paths = await this.store.listByPrefix(HUMAN_SESSIONS_DIR);
    const out: DeviceHistoryEntry[] = [];
    for (const p of paths) {
      const raw = await this.store.loadRawAt<unknown>("human-session", p);
      const hs = raw?.payload as HumanSessionLike | undefined;
      if (!hs?.device) continue;
      out.push({
        sessionId: hs.sessionId,
        userAgent: hs.device.userAgent ?? "",
        platform: hs.device.platform ?? "",
        screenPx: hs.device.screenPx ?? { width: 0, height: 0 },
        pointerCoalescingSupported:
          hs.device.pointerCoalescingSupported ?? null,
      });
    }
    return out;
  }

  async optimizerVersionHistory(): Promise<OptimizerVersionHistoryEntry[]> {
    const sessions = await this.listSessions();
    const out: OptimizerVersionHistoryEntry[] = [];
    for (const s of sessions) {
      const meta = await this.store.loadRawAt<{ optimizerVersion?: string }>(
        "optimizer-run",
        `optimizer-runs/${s.experimentId}.json`,
      );
      out.push({
        experimentId: s.experimentId,
        optimizerVersion: meta?.payload?.optimizerVersion ?? null,
      });
    }
    return out;
  }

  /** Convenience: everything in one call for a dashboard-style view. */
  async snapshot(): Promise<HistorySnapshot> {
    const [
      sessions,
      trendsData,
      rankingHistory,
      dimensionTrend,
      calibrationHistory,
      retestLineage,
      deviceHistory,
      optimizerVersions,
    ] = await Promise.all([
      this.listSessions(),
      this.trends(),
      this.rankingHistory(),
      this.dimensionTrend(),
      this.calibrationHistory(),
      this.retestLineage(),
      this.deviceHistory(),
      this.optimizerVersionHistory(),
    ]);
    return {
      sessions,
      trends: trendsData,
      rankingHistory,
      dimensionTrend,
      calibrationHistory,
      retestLineage,
      deviceHistory,
      optimizerVersions,
    };
  }
}
