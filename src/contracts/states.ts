import type { HistorySnapshot } from "../history/api.ts";
import type { FinalResult } from "../results/finalResult.ts";

/**
 * Contract-level async result states (Pass 5, requirements K/L).
 *
 * History and results contracts expose explicit empty/loading/error states so
 * a UI never has to infer state from absent data. These are plain
 * discriminated unions — renderable verbatim.
 */

export type ContractState<T> =
  | { state: "empty"; message: string }
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; code: string; userMessage: string };

export function emptyState<T>(message: string): ContractState<T> {
  return { state: "empty", message };
}

export function loadingState<T>(): ContractState<T> {
  return { state: "loading" };
}

export function readyState<T>(data: T): ContractState<T> {
  return { state: "ready", data };
}

export function errorState<T>(code: string, userMessage: string): ContractState<T> {
  return { state: "error", code, userMessage };
}

/** Wraps a promise-producing history snapshot into an explicit contract state. */
export async function loadHistoryContract(
  op: () => Promise<HistorySnapshot>,
): Promise<ContractState<HistorySnapshot>> {
  try {
    const snap = await op();
    if (
      snap.sessions.length === 0 &&
      snap.calibrationHistory.length === 0 &&
      snap.retestLineage.length === 0
    ) {
      return emptyState<HistorySnapshot>(
        "No sessions recorded yet. Complete your first session to start building history.",
      );
    }
    return readyState(snap);
  } catch (err) {
    return errorState<HistorySnapshot>(
      "HISTORY_LOAD_FAILED",
      err instanceof Error ? err.message : "history could not be loaded",
    );
  }
}

/** Wraps final-result assembly into an explicit contract state. */
export async function loadResultsContract(
  op: () => Promise<FinalResult | null>,
): Promise<ContractState<FinalResult>> {
  try {
    const result = await op();
    if (result === null) {
      return emptyState<FinalResult>(
        "No recommendation available for this experiment yet.",
      );
    }
    return readyState(result);
  } catch (err) {
    return errorState<FinalResult>(
      "RESULTS_ASSEMBLY_FAILED",
      err instanceof Error ? err.message : "results could not be assembled",
    );
  }
}
