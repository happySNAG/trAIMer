import {
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  edpi,
  playerPreset,
  equalXy,
} from "../index.ts";
import { estimateCompositeOptimumEdpi } from "../sim/calibrate.ts";

interface CliArgs {
  seed: number;
  hiddenEdpi: number;
  preset: "consistent-medium" | "jittery-fast" | "deliberate-slow" | "noisy-beginner";
  baselinePercent: number;
  dpi: number;
  repsPerCandidate: number;
  maxRounds: number;
  calibrate: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i + 1 < argv.length; i += 2) {
    if (argv[i]!.startsWith("--")) args.set(argv[i]!, argv[i + 1] ?? "");
  }
  const num = (name: string, fallback: number): number => {
    const v = args.get(`--${name}`);
    const parsed = v !== undefined ? Number(v) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const presetArg = args.get("--preset");
  const preset =
    presetArg === "jittery-fast" ||
    presetArg === "deliberate-slow" ||
    presetArg === "noisy-beginner"
      ? presetArg
      : "consistent-medium";
  return {
    seed: num("seed", 20260822),
    hiddenEdpi: num("hidden-edpi", 5600),
    preset,
    baselinePercent: num("baseline", 7),
    dpi: num("dpi", 800),
    repsPerCandidate: Math.max(3, Math.round(num("reps", 7))),
    maxRounds: Math.max(1, Math.round(num("rounds", 2))),
    calibrate: argv.includes("--calibrate"),
  };
}

export function runDemo(cliArgs: CliArgs, log: (line: string) => void): void {
  const player = {
    ...playerPreset(cliArgs.preset),
    trueOptimalEdpi: cliArgs.hiddenEdpi,
  };
  const trueSensX = cliArgs.hiddenEdpi / cliArgs.dpi;
  const baselineSensitivity = equalXy(cliArgs.baselinePercent);

  log("Aldo Aim Lab — synthetic demonstration");
  log("");
  log(
    `Player: ${player.displayName} | DPI ${cliArgs.dpi} | baseline ${cliArgs.baselinePercent}%/` +
      `${cliArgs.baselinePercent}% (${edpi(cliArgs.dpi, cliArgs.baselinePercent)} eDPI)`,
  );
  log(
    `Hidden simulator optimum: ${cliArgs.hiddenEdpi} eDPI (= ${trueSensX.toFixed(2)}% at ${cliArgs.dpi} DPI) — withheld from the optimizer`,
  );
  log("");

  const definition = buildExperimentDefinition({
    id: "experiment-demo",
    name: `sensitivity search (${player.displayName})`,
    baselineSensitivity,
    dpi: cliArgs.dpi,
    ladderFactors: [1 / 1.35, 1 / 1.15, 1, 1.15, 1.35],
    measuredRepsPerCandidatePerRound: cliArgs.repsPerCandidate,
    orderSeed: cliArgs.seed,
    stoppingCriteria: { maxSearchRounds: cliArgs.maxRounds },
  });

  log(
    `Stage-1 candidates: ${definition.candidates
      .map((c) => `${(cliArgs.dpi * c.sensitivity.sensX).toFixed(0)}`)
      .join(", ")} eDPI`,
  );

  const runner = new SyntheticExperimentRunner(definition, player);
  const optimizer = new SensitivityOptimizer(definition, {
    minValidTrialsPerCandidate: 4,
    maxSearchRounds: cliArgs.maxRounds,
  });

  let round = 0;
  let totalTrials = 0;
  const firstTrials = runner.runRound(round, cliArgs.seed, "session-demo", definition.id);
  optimizer.addTrials(firstTrials);
  totalTrials += firstTrials.length;
  log(`Round 0: simulated ${firstTrials.length} trials (warmup + measured)`);

  while (true) {
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "done") break;
    round = next.round;
    const refinementIds = next.candidates.map((c) => c.id);
    optimizer.addCandidates(next.candidates);
    log(
      `Round ${round}: refining with candidates ${next.candidates
        .map((c) => `${(cliArgs.dpi * c.sensitivity.sensX).toFixed(0)}`)
        .join(", ")} eDPI`,
    );
    const trials = runner.runRound(
      round,
      cliArgs.seed,
      "session-demo",
      definition.id,
      refinementIds,
    );
    optimizer.addTrials(trials);
    totalTrials += trials.length;
  }

  const recommendation = optimizer.recommend();

  log("");
  log("--- Recommendation ---");
  log(
    `Primary: sensX=${recommendation.primarySensitivity.sensX.toFixed(2)}% ` +
      `sensY=${recommendation.primarySensitivity.sensY.toFixed(2)}% ` +
      `(${recommendation.recommendedEdpi.toFixed(0)} eDPI)`,
  );
  log(
    `Plausible range: ${recommendation.sensXRange.min.toFixed(2)}–${recommendation.sensXRange.max.toFixed(2)}% ` +
      `(${recommendation.edpiRange.min.toFixed(0)}–${recommendation.edpiRange.max.toFixed(0)} eDPI)`,
  );
  log(
    `Confidence: ${(recommendation.confidence * 100).toFixed(0)}% (${recommendation.confidenceLabel})` +
      `${recommendation.refusedHighConfidence ? " — high confidence refused" : ""}`,
  );
  for (const w of recommendation.warnings) log(`Warning: ${w}`);
  for (const line of recommendation.rationaleLines) log(`· ${line}`);
  log(
    `Evidence: analyzed=${recommendation.evidence.trialsAnalyzed} excluded=${recommendation.evidence.trialsExcluded} ` +
      `separation=${recommendation.evidence.separation} rounds=${recommendation.evidence.searchRoundsRun}`,
  );

  log("");
  log("--- Hidden optimum reveal ---");
  const recEdpi = recommendation.recommendedEdpi;
  const errPct = ((recEdpi - cliArgs.hiddenEdpi) / cliArgs.hiddenEdpi) * 100;
  const octaveErr = Math.log2(recEdpi / cliArgs.hiddenEdpi);
  const inRange =
    cliArgs.hiddenEdpi >= recommendation.edpiRange.min &&
    cliArgs.hiddenEdpi <= recommendation.edpiRange.max;
  log(`Nominal hidden knob eDPI: ${cliArgs.hiddenEdpi}`);
  if (cliArgs.calibrate) {
    const calibration = estimateCompositeOptimumEdpi(player, {
      dpi: cliArgs.dpi,
      baselineSensitivityPercent: cliArgs.baselinePercent,
      repsPerCandidatePerRound: 16,
      rounds: 3,
      seedBase: 900001,
    });
    const calErrPct =
      ((recEdpi - calibration.compositeOptimumEdpi) /
        calibration.compositeOptimumEdpi) *
      100;
    log(
      `Measured composite optimum (Monte-Carlo, ${calibration.method}): ` +
        `${calibration.compositeOptimumEdpi.toFixed(0)} eDPI`,
    );
    log(
      `Error vs measured composite optimum: ${calErrPct >= 0 ? "+" : ""}${calErrPct.toFixed(1)}%`,
    );
    log(
      "note: the measured optimum balances speed, accuracy and control dimensions; it need not equal the nominal amplitude-error null",
    );
  }
  log(`Recommended eDPI:       ${recEdpi.toFixed(0)}  (error vs nominal ${errPct >= 0 ? "+" : ""}${errPct.toFixed(1)}%, ${octaveErr.toFixed(3)} octaves)`);
  log(`Nominal inside reported range: ${inRange ? "yes" : "NO"}`);
  log(`Total simulated trials: ${totalTrials}`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (isDirectRun) {
  runDemo(parseArgs(process.argv.slice(2)), (line) => console.log(line));
}
