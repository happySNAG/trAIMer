import type { PreflightReport } from "../../src/preflight/preflight.ts";
import { el, clear } from "./dom.ts";

const VERDICT_LABELS: Record<PreflightReport["overall"], string> = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready with warnings",
  NOT_READY_FOR_HIGH_CONFIDENCE: "Not ready for high-confidence testing",
  BLOCKED: "Blocked — fix the failures below before testing",
};

/** Renders the preflight report on the Setup tab (Pass 5, requirement E). */
export function renderPreflightPanel(
  container: HTMLElement,
  report: PreflightReport | null,
  errorText: string | null,
): void {
  clear(container);
  if (errorText) {
    container.append(
      el("p", { class: "danger", text: `preflight unavailable: ${errorText}` }),
    );
    return;
  }
  if (!report) return;
  container.append(
    el("h3", { text: `Preflight — ${VERDICT_LABELS[report.overall]}` }),
    el("p", {
      class: "note",
      text: `${report.release.appVersion} · ${report.release.engineVersion} · checked ${new Date(report.generatedAtIso).toLocaleTimeString()}`,
    }),
  );
  const table = el("table", {});
  table.append(
    el("tr", {}, [
      el("th", { text: "Check" }),
      el("th", { text: "Status" }),
      el("th", { text: "Detail" }),
    ]),
  );
  for (const check of report.checks) {
    const statusLabel =
      check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    const code = check.reasonCode ? ` (${check.reasonCode})` : "";
    table.append(
      el("tr", {}, [
        el("td", { text: check.name }),
        el("td", { text: `${statusLabel}${code}` }),
        el("td", { text: check.detail }),
      ]),
    );
  }
  container.append(table);
}
