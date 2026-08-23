import type {
  PreflightCheck,
  PreflightCheckName,
  PreflightReport,
} from "../../src/preflight/preflight.ts";
import { el, clear } from "./dom.ts";
import { badge, button, card, formatDateTime, icon, type Tone } from "./ui.ts";

const VERDICT_META: Record<
  PreflightReport["overall"],
  { tone: Tone; label: string; blurb: string }
> = {
  READY: {
    tone: "ok",
    label: "Ready",
    blurb: "All system checks passed — conditions are good for a high-confidence session.",
  },
  READY_WITH_WARNINGS: {
    tone: "warn",
    label: "Ready with warnings",
    blurb: "You can test now. Fixing the warnings below improves result quality.",
  },
  NOT_READY_FOR_HIGH_CONFIDENCE: {
    tone: "warn",
    label: "Limited confidence",
    blurb:
      "Testing will run, but the engine will cap confidence until the items below are resolved.",
  },
  BLOCKED: {
    tone: "danger",
    label: "Blocked",
    blurb: "Reliable measurement is not possible yet. Fix the flagged items before testing.",
  },
};

/**
 * Player-facing grouping of engine checks (presentation only). The panel lays
 * out in CSS columns, so the tall CAPTURE group is listed last to pack into
 * its own column instead of leaving a void beside the short groups.
 */
const GROUPS: { name: string; checks: PreflightCheckName[] }[] = [
  { name: "Mouse", checks: ["pointer-capture-mode", "dpi-configured"] },
  { name: "Sensitivity", checks: ["xy-configured"] },
  { name: "Calibration", checks: ["calibration-state"] },
  { name: "Display", checks: ["viewport-display"] },
  { name: "Storage", checks: ["persistent-storage"] },
  {
    name: "System",
    checks: ["runtime-support", "version-compatibility", "unfinished-checkpoints"],
  },
  {
    name: "Capture",
    checks: [
      "native-helper-presence",
      "native-protocol-compatibility",
      "active-capture-tier",
      "observed-input-rate",
      "timestamp-monotonicity",
      "jitter-and-drop-diagnostics",
    ],
  },
];

const CHECK_LABELS: Record<PreflightCheckName, string> = {
  "runtime-support": "Browser support",
  "pointer-capture-mode": "Pointer capture",
  "native-helper-presence": "Capture helper",
  "native-protocol-compatibility": "Helper protocol",
  "active-capture-tier": "Capture tier",
  "observed-input-rate": "Input rate",
  "timestamp-monotonicity": "Timing integrity",
  "jitter-and-drop-diagnostics": "Jitter & drops",
  "dpi-configured": "Mouse DPI",
  "xy-configured": "X/Y settings",
  "calibration-state": "Physical calibration",
  "persistent-storage": "Storage space",
  "viewport-display": "Display size",
  "unfinished-checkpoints": "Saved sessions",
  "version-compatibility": "Version compatibility",
};

const STATUS_META: Record<PreflightCheck["status"], { tone: Tone; label: string }> = {
  pass: { tone: "ok", label: "Ready" },
  warn: { tone: "warn", label: "Warning" },
  fail: { tone: "danger", label: "Needs attention" },
};

function worst(checks: PreflightCheck[]): PreflightCheck["status"] {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

/** Renders the preflight report on the Test tab (engine verdicts verbatim). */
export function renderPreflightPanel(
  container: HTMLElement,
  report: PreflightReport | null,
  errorText: string | null,
  onRefresh?: () => void,
): void {
  clear(container);
  if (errorText) {
    container.append(
      card(
        {
          title: "System check unavailable",
          icon: "warn",
          tone: "danger",
          actions: onRefresh
            ? [button("Run checks again", { variant: "ghost", icon: "history", onClick: onRefresh })]
            : [],
        },
        el("p", { class: "muted", text: "The preflight check could not run. Your data is safe; testing may still work, but confidence gating cannot be verified." }),
        el("p", { class: "preflight-check-code", text: errorText }),
      ),
    );
    return;
  }
  if (!report) return;

  const meta = VERDICT_META[report.overall];

  const groupsWrap = el("div", { class: "preflight-groups" });
  const rendered = new Set<string>();
  for (const group of GROUPS) {
    const checks = report.checks.filter((c) => group.checks.includes(c.name));
    if (checks.length === 0) continue;
    for (const c of checks) rendered.add(c.name);
    groupsWrap.append(buildGroup(group.name, checks));
  }
  // Any engine check not covered by the grouping still must surface.
  const leftovers = report.checks.filter((c) => !rendered.has(c.name));
  if (leftovers.length > 0) {
    groupsWrap.append(buildGroup("Other", leftovers));
  }

  const actions: HTMLElement[] = [badge(meta.tone, meta.label, { dot: true })];
  if (onRefresh) {
    actions.push(
      button("Run checks again", { variant: "ghost", icon: "history", onClick: onRefresh }),
    );
  }
  container.append(
    card(
      {
        title: "System readiness",
        subtitle: `Checked ${formatDateTime(report.generatedAtIso)} · ${report.release.appVersion} · ${report.release.engineVersion}`,
        icon: "shield",
        tone: meta.tone,
        actions,
      },
      el("p", { class: "muted", text: meta.blurb }),
      groupsWrap,
    ),
  );
}

function buildGroup(name: string, checks: PreflightCheck[]): HTMLElement {
  const status = worst(checks);
  const meta = STATUS_META[status];
  const details = el("details", { class: "preflight-group" });
  if (status !== "pass") details.setAttribute("open", "");

  const summary = el("summary", {});
  summary.append(
    el("span", { class: `tone-${meta.tone}` }, [
      icon(status === "pass" ? "check" : status === "warn" ? "warn" : "x", 15),
    ]),
    el("span", { class: "preflight-group-name", text: name }),
    el("span", { class: `preflight-group-state tone-${meta.tone}`, text: meta.label }),
  );
  details.append(summary);

  const list = el("div", { class: "preflight-checks" });
  for (const check of checks) {
    const checkMeta = STATUS_META[check.status];
    const item = el("div", { class: "preflight-check" });
    item.append(
      el("span", { class: `tone-${checkMeta.tone}` }, [
        icon(check.status === "pass" ? "check" : check.status === "warn" ? "warn" : "x", 13),
      ]),
    );
    const text = el("div", {});
    text.append(el("span", { class: "preflight-check-name", text: CHECK_LABELS[check.name] ?? check.name }));
    text.append(el("p", { class: "preflight-check-detail", text: check.detail }));
    if (check.reasonCode) {
      text.append(el("p", { class: "preflight-check-code", text: check.reasonCode }));
    }
    item.append(text);
    list.append(item);
  }
  details.append(list);
  return details;
}
