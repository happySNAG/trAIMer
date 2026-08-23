import {
  summarizeCheckpointForUi,
  parseResumeCheckpoint,
  type ResumeCheckpoint,
} from "../../src/session/resume.ts";
import type { LocalJsonStore } from "../../src/persistence/store.ts";
import { el } from "./dom.ts";
import { badge, button, formatAgo, formatDateTime, icon } from "./ui.ts";

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
      const warnCard = el("div", { class: "checkpoint-card" });
      warnCard.append(
        el("span", { class: "tone-danger" }, [icon("warn", 20)]),
        el("div", { class: "checkpoint-main" }, [
          el("span", { class: "checkpoint-title", text: "Corrupted saved session" }),
          el("span", {
            class: "checkpoint-meta",
            text: `The checkpoint at ${p} could not be read. Export it for diagnosis before discarding.`,
          }),
        ]),
      );
      container.append(warnCard);
    }
  }
  if (entries.length === 0) return;

  for (const { checkpoint } of entries) {
    const summary = summarizeCheckpointForUi(
      checkpoint,
      {
        name: "unknown",
        stoppingCriteria: { maxTotalMeasuredTrials: 1 },
      } as never,
      new Date().toISOString(),
    );

    const metaBits: HTMLElement[] = [
      el("span", { text: `Started ${formatDateTime(summary.startedAtIso)}` }),
      el("span", {
        class: "mono",
        text: `${summary.completedMeasuredTrials} trials completed · round ${summary.currentRound + 1}`,
      }),
      el("span", { text: `Capture: ${checkpoint.captureSource?.kind ?? "not recorded"}` }),
      el("span", { text: formatAgo(summary.ageMs) }),
    ];
    if (summary.hasInterruptedTrial) {
      metaBits.push(el("span", { class: "tone-warn", text: "one interrupted trial will be excluded" }));
    }

    const main = el("div", { class: "checkpoint-main" });
    const titleRow = el("span", { class: "checkpoint-title" });
    titleRow.append(
      el("span", { text: `Unfinished session — ${summary.playerName}` }),
    );
    const metaRow = el("span", { class: "checkpoint-meta" });
    metaRow.append(...metaBits);
    main.append(titleRow, metaRow, el("span", {
      class: "checkpoint-meta muted",
      text: "Progress is saved. Resuming restores blinding, completed trials, and search state exactly.",
    }));

    const actions = el("div", { class: "checkpoint-actions" });
    const resumeBtn = button("Resume", { variant: "primary", icon: "play" });
    resumeBtn.addEventListener("click", () => callbacks.onResume(checkpoint));
    const exportBtn = button("Export diagnostic bundle", { variant: "ghost", icon: "download" });
    exportBtn.addEventListener("click", () => callbacks.onExport(checkpoint));
    const discardBtn = button("Discard", { variant: "danger" });
    discardBtn.addEventListener("click", () => callbacks.onDiscard(checkpoint));
    actions.append(resumeBtn, exportBtn, discardBtn);

    const cardEl = el("div", { class: "checkpoint-card", "data-role": "checkpoint" });
    cardEl.append(
      el("span", { class: "tone-info" }, [icon("clock", 22)]),
      main,
      badge(checkpoint.status === "interrupted" ? "warn" : "info", checkpoint.status),
      actions,
    );
    container.append(cardEl);
  }
}
