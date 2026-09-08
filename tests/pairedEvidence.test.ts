import { describe, expect, it } from "vitest";
import {
  planCandidateBlocks,
  buildExperimentDefinition,
  PAIR_INDEX_ROUND_STRIDE,
} from "../src/experiments/protocol.ts";
import { makeExperimentId } from "../src/domain/ids.ts";
import { equalXy } from "../src/domain/settings.ts";
import {
  CALIBRATION_MODES,
  CALIBRATION_MODE_ORDER,
} from "../src/experiments/sessionModes.ts";
import {
  BOUNDARY_CONFIDENCE_CAP,
  computeConfidence,
  equivalentNormalZ,
  studentTCdf,
} from "../src/optimizer/confidence.ts";

/**
 * The paired comparison is the thing the whole search leans on to cancel
 * scenario and instance effects — and until Pass 14 it was running at roughly
 * a quarter of its design power, because two candidates shared a cell only
 * when their independently shuffled block orders happened to agree.
 *
 * These tests hold pairing as a property of the PLAN, and hold the
 * small-sample correction that a working paired comparison then requires.
 */

function plan(
  modeId: (typeof CALIBRATION_MODE_ORDER)[number],
  seed: number,
  round = 0,
) {
  const mode = CALIBRATION_MODES[modeId];
  const definition = buildExperimentDefinition({
    id: makeExperimentId(`pair-${seed}`),
    name: "pair",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    orderSeed: seed,
    measuredRepsPerCandidatePerRound: mode.measuredRepsPerCandidatePerRound,
    warmupTrialsPerCandidateBlock: mode.warmupTrialsPerCandidateBlock,
    stoppingCriteria: { maxSearchRounds: mode.rounds },
  });
  return { definition, specs: planCandidateBlocks(definition, round) };
}

/** cell key → set of candidates that play it. */
function cellsByCandidate(specs: ReturnType<typeof plan>["specs"]) {
  const out = new Map<string, Set<string>>();
  for (const spec of specs) {
    if (spec.phase !== "measured") continue;
    const key = `${spec.scenarioId}#${spec.pairIndex}`;
    const set = out.get(spec.candidateId) ?? new Set<string>();
    set.add(key);
    out.set(spec.candidateId, set);
  }
  return out;
}

describe("pairing is a property of the plan, not of luck", () => {
  it("every measured cell has a partner in every candidate, in every mode", () => {
    for (const modeId of CALIBRATION_MODE_ORDER) {
      for (let seed = 1; seed <= 50; seed++) {
        const { specs } = plan(modeId, seed);
        const byCandidate = cellsByCandidate(specs);
        const sets = [...byCandidate.values()];
        expect(sets.length).toBeGreaterThan(1);
        const first = sets[0]!;
        for (const other of sets.slice(1)) {
          expect(
            [...first].every((k) => other.has(k)),
            `${modeId} seed ${seed}: cell sets differ`,
          ).toBe(true);
          expect(other.size).toBe(first.size);
        }
      }
    }
  });

  it("a candidate's cells are exactly its measured reps", () => {
    for (const modeId of CALIBRATION_MODE_ORDER) {
      const mode = CALIBRATION_MODES[modeId];
      const { specs } = plan(modeId, 7);
      for (const cells of cellsByCandidate(specs).values()) {
        expect(cells.size).toBe(mode.measuredRepsPerCandidatePerRound);
      }
    }
  });

  it("the same drill twice in one block occupies two cells, never one", () => {
    // Five families and eight reps means at least one family repeats.
    const { specs } = plan("standard", 3);
    const perCandidate = new Map<string, string[]>();
    for (const spec of specs) {
      if (spec.phase !== "measured") continue;
      const list = perCandidate.get(spec.candidateId) ?? [];
      list.push(`${spec.scenarioId}#${spec.pairIndex}`);
      perCandidate.set(spec.candidateId, list);
    }
    for (const list of perCandidate.values()) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("rounds are separate exposures and never share a cell", () => {
    const r0 = plan("precision", 5, 0).specs.filter((s) => s.phase === "measured");
    const r1 = plan("precision", 5, 1).specs.filter((s) => s.phase === "measured");
    const keys0 = new Set(r0.map((s) => `${s.scenarioId}#${s.pairIndex}`));
    for (const spec of r1) {
      expect(keys0.has(`${spec.scenarioId}#${spec.pairIndex}`)).toBe(false);
      expect(spec.pairIndex!).toBeGreaterThanOrEqual(PAIR_INDEX_ROUND_STRIDE);
    }
  });

  it("warm-ups carry no cell — they are never scored", () => {
    const { specs } = plan("standard", 2);
    for (const spec of specs) {
      if (spec.phase === "warmup") expect(spec.pairIndex).toBeNull();
      else expect(spec.pairIndex).not.toBeNull();
    }
  });

  it("a reduced allocation is a NESTED subset, so it still pairs on what it plays", () => {
    const mode = CALIBRATION_MODES.standard;
    const definition = buildExperimentDefinition({
      id: makeExperimentId("alloc"),
      name: "alloc",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      orderSeed: 21,
      measuredRepsPerCandidatePerRound: mode.measuredRepsPerCandidatePerRound,
      warmupTrialsPerCandidateBlock: mode.warmupTrialsPerCandidateBlock,
    });
    const ids = definition.candidates.map((c) => c.id);
    const allocation = new Map(ids.map((id, i) => [id, i === 0 ? 4 : 8]));
    const specs = planCandidateBlocks(definition, 1, undefined, allocation);
    const byCandidate = cellsByCandidate(specs);
    const reduced = byCandidate.get(ids[0]!)!;
    expect(reduced.size).toBe(4);
    for (const id of ids.slice(1)) {
      const full = byCandidate.get(id)!;
      expect(full.size).toBe(8);
      // Every cell the reduced candidate plays has a partner.
      expect([...reduced].every((k) => full.has(k))).toBe(true);
    }
  });

  it("order still varies per candidate, so order effects do not confound", () => {
    const { specs } = plan("standard", 4);
    const orders = new Map<string, string>();
    for (const spec of specs) {
      if (spec.phase !== "measured") continue;
      orders.set(
        spec.candidateId,
        (orders.get(spec.candidateId) ?? "") + spec.scenarioId + "|",
      );
    }
    expect(new Set(orders.values()).size).toBeGreaterThan(1);
  });

  it("no drill runs twice in a row inside a block", () => {
    const { specs } = plan("precision", 6);
    let previous: { candidateId: string; scenarioId: string } | null = null;
    const catalogSize = 5;
    for (const spec of specs) {
      if (spec.phase !== "measured") continue;
      if (previous && previous.candidateId === spec.candidateId) {
        // Only possible when one family holds more than half the slots.
        expect(previous.scenarioId === spec.scenarioId && catalogSize >= 5).toBe(false);
      }
      previous = { candidateId: spec.candidateId, scenarioId: spec.scenarioId };
    }
  });
});

describe("a working paired comparison needs a small-sample correction", () => {
  it("reproduces Student's t to the published quantiles", () => {
    const known: [number, number][] = [
      [1, 12.706],
      [2, 4.303],
      [4, 2.776],
      [8, 2.306],
      [16, 2.12],
      [30, 2.042],
    ];
    for (const [df, q] of known) {
      expect(studentTCdf(q, df), `df=${df}`).toBeCloseTo(0.975, 4);
    }
    expect(studentTCdf(0, 5)).toBeCloseTo(0.5, 9);
    expect(studentTCdf(-2, 5)).toBeCloseTo(1 - studentTCdf(2, 5), 9);
  });

  it("converts a t statistic into the normal z carrying the same evidence", () => {
    // The 95 % point on 4 df carries exactly the evidence of z = 1.96.
    expect(equivalentNormalZ(2.776, 4)).toBeCloseTo(1.96, 2);
    expect(equivalentNormalZ(2.306, 8)).toBeCloseTo(1.96, 2);
    // Small samples are DISCOUNTED, never inflated…
    expect(equivalentNormalZ(2, 4)).toBeLessThan(2);
    expect(equivalentNormalZ(2, 15)).toBeLessThan(2);
    expect(equivalentNormalZ(2, 4)).toBeLessThan(equivalentNormalZ(2, 15));
    // …and large ones converge on the normal.
    expect(equivalentNormalZ(2, 500)).toBeCloseTo(2, 6);
    expect(equivalentNormalZ(0, 4)).toBeCloseTo(0, 9);
  });

  it("a Quick session's five cells are read as five cells", () => {
    // 5 paired cells ⇒ 4 df. Reading t=2.5 as a normal z would claim 98.8 %;
    // on 4 df it is 96.7 %.
    const asNormal = 2.5;
    const corrected = equivalentNormalZ(asNormal, 4);
    expect(corrected).toBeLessThan(asNormal);
    expect(computeConfidence({
      utilityGapZ: corrected,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    })).toBeLessThan(computeConfidence({
      utilityGapZ: asNormal,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    }));
  });

  it("survives degenerate inputs rather than propagating NaN", () => {
    expect(equivalentNormalZ(Number.NaN, 4)).toBe(0);
    expect(equivalentNormalZ(2, 0)).toBe(0);
    expect(Number.isFinite(equivalentNormalZ(1e9, 4))).toBe(true);
    expect(studentTCdf(Number.POSITIVE_INFINITY, 4)).toBe(0.5);
  });
});

describe("an unresolved search boundary caps confidence", () => {
  it("caps rather than deducts", () => {
    // A clean separation INSIDE the tested range says nothing about outside
    // it, so a boundary run cannot report a confident value however clean it
    // looks.
    const clean = {
      utilityGapZ: 6,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      candidatesWithData: 5,
    };
    const interior = computeConfidence({ ...clean, bestAtSearchBoundary: false });
    const boundary = computeConfidence({ ...clean, bestAtSearchBoundary: true });
    expect(interior).toBeGreaterThan(0.9);
    expect(boundary).toBeLessThanOrEqual(BOUNDARY_CONFIDENCE_CAP);
    // rc.7 deducted a flat 0.1, which left this case above 0.8 — "high".
    expect(interior - 0.1).toBeGreaterThan(BOUNDARY_CONFIDENCE_CAP);
  });

  it("still lowers a weak boundary run rather than raising it to the cap", () => {
    const weak = computeConfidence({
      utilityGapZ: 0.4,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: true,
      candidatesWithData: 5,
    });
    expect(weak).toBeLessThan(0.35);
  });
});
