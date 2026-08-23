import {
  summarizeCheckpointForUi,
  parseResumeCheckpoint,
  type ResumeCheckpoint,
} from "../../src/session/resume.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el } from "./dom.ts";

export interface ResumeListCallbacks {
  onResume(checkpoint: ResumeCheckpoint): void;
  onDiscard(checkpoint: ResumeCheckpoint): void;
  onExport(checkpoint: ResumeCheckpoint): void;
}

/**
 * Startup resume list (requirement L). Lists every incomplete session with
 * the mandated fields and explicit actions; never resumes anything silently.
 */
export async function renderResumeList(
  container: HTMLElement,
  store: LocalJsonStore,
  callbacks: ResumeListCallbacks,
): Promise<void> {
  const paths = await store.listByPrefix("sessions/checkpoints");
  const entries: { path: string; checkpoint: ResumeCheckpoint }[] = [];
  for (const p of paths) {
    const loaded = await store.loadRawAt<unknown>("session-checkpoint", p);
    try {
      const checkpoint = parseResumeCheckpoint(loaded?.payload);
      if (checkpoint.status === "running" || checkpoint.status === "interrupted") {
        entries.push({ path: p, checkpoint });
      }
    } catch {
      // Corrupted checkpoints are surfaced, not hidden.
      container.append(
        el("p", { class: "danger", text: `corrupted checkpoint at ${p} — export it before discarding` }),
      );
    }
  }
  if (entries.length === 0 && container.children.length === 0) return;

  container.append(el("h3", { text: "Incomplete sessions — pick up where you left off?" }));
  const table = el("table", {});
  table.append(
    el("tr", {}, [
      el("th", { text: "Player" }),
      el("th", { text: "Experiment" }),
      el("th", { text: "Started" }),
      el("th", { text: "Progress" }),
      el("th", { text: "Round / capture" }),
      el("th", { text: "Age" }),
      el("th", { text: "Actions" }),
    ]),
  );
  for (const { checkpoint } of entries) {
    const summary = summarizeCheckpointForUi(
      checkpoint,
      {
        name: "unknown",
        stoppingCriteria: { maxTotalMeasuredTrials: 1 },
      } as never,
      new Date().toISOString(),
    );
    const ageMin = Math.round(summary.ageMs / 60000);
    const ageLabel = ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`;
    const row = el("tr", {}, [
      el("td", { text: summary.playerName }),
      el("td", { text: summary.experimentLabel }),
      el("td", { text: new Date(summary.startedAtIso || "").toLocaleString() }),
      el("td", {
        text:
          `${summary.completedMeasuredTrials} measured trials · ${summary.lastValidState}` +
          (summary.hasInterruptedTrial ? " · interrupted trial pending" : ""),
      }),
      el("td", {
        text: `round ${summary.currentRound} · ${checkpoint.captureSource?.kind ?? "capture n/a"}`,
      }),
      el("td", { text: ageLabel }),
    ]);
    const actions = el("td", {});
    const resumeBtn = el("button", { class: "primary", text: "Resume" });
    resumeBtn.addEventListener("click", () => callbacks.onResume(checkpoint));
    const exportBtn = el("button", { text: "Export diagnostic bundle" });
    exportBtn.addEventListener("click", () => callbacks.onExport(checkpoint));
    const discardBtn = el("button", { class: "danger", text: "Discard" });
    discardBtn.addEventListener("click", () => callbacks.onDiscard(checkpoint));
    actions.append(resumeBtn, exportBtn, discardBtn);
    row.append(actions);
    table.append(row);
  }
  container.append(table);
}
