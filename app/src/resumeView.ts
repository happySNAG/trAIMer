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

  // One reassurance line for the whole list — not repeated per card.
  const intro = el("p", { class: "resume-intro" });
  intro.append(
    icon("shield", 13),
    el("span", {
      text: "Unfinished sessions are safe: resuming restores blinding, completed trials, and search state exactly.",
    }),
  );
  container.append(intro);

  let first = true;
  for (const { checkpoint } of entries) {
    const summary = summarizeCheckpointForUi(
      checkpoint,
      {
        name: "unknown",
        stoppingCriteria: { maxTotalMeasuredTrials: 1 },
      } as never,
      new Date().toISOString(),
    );

    const hasName = summary.playerName && summary.playerName !== "unknown player";
    const metaBits: HTMLElement[] = [
      el("span", { text: `Started ${formatDateTime(summary.startedAtIso)}` }),
      el("span", {
        class: "mono",
        text: `${summary.completedMeasuredTrials} trials · round ${summary.currentRound + 1}`,
      }),
      el("span", { text: formatAgo(summary.ageMs) }),
    ];
    if (checkpoint.captureSource?.kind) {
      metaBits.splice(2, 0, el("span", { text: `capture: ${checkpoint.captureSource.kind}` }));
    }
    if (summary.hasInterruptedTrial) {
      metaBits.push(el("span", { class: "tone-warn", text: "one interrupted trial will be excluded" }));
    }

    const main = el("div", { class: "checkpoint-main" });
    const titleRow = el("span", { class: "checkpoint-title" });
    titleRow.append(
      el("span", { text: hasName ? `Unfinished session — ${summary.playerName}` : "Unfinished session" }),
    );
    const metaRow = el("span", { class: "checkpoint-meta" });
    metaRow.append(...metaBits);
    main.append(titleRow, metaRow);

    const actions = el("div", { class: "checkpoint-actions" });
    // Accent stays special: only the most recent checkpoint gets the primary
    // treatment; older ones resume via a quieter control.
    const resumeBtn = button("Resume", { variant: first ? "primary" : "secondary", icon: "play" });
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
      badge(checkpoint.status === "interrupted" ? "warn" : "info", checkpoint.status, { dot: true }),
      actions,
    );
    container.append(cardEl);
    first = false;
  }
}
