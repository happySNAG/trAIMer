/**
 * Aldo Aim Lab — UI component library (UI Design Pass 1).
 *
 * Reusable presentation primitives only: icons, badges, cards, buttons,
 * meters, charts, dialogs and empty states. Everything renders through
 * `el()`/`textContent` and namespaced SVG builders — never innerHTML — and
 * never computes a domain value (docs/UI-CONTRACT.md §4).
 */
import { el } from "./dom.ts";

// ---------------------------------------------------------------------------
// SVG primitives
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  children: SVGElement[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

export type IconName =
  | "home"
  | "target"
  | "results"
  | "history"
  | "calibration"
  | "diagnostics"
  | "data"
  | "play"
  | "pause"
  | "check"
  | "warn"
  | "x"
  | "info"
  | "mouse"
  | "monitor"
  | "zap"
  | "download"
  | "upload"
  | "arrow-right"
  | "shield"
  | "clock"
  | "storage"
  | "pulse"
  | "settings"
  | "crosshair"
  | "flag";

const ICON_PATHS: Record<IconName, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.6V21h14V9.6"],
  target: [
    "M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z",
    "M12 2v4", "M12 18v4", "M2 12h4", "M18 12h4",
  ],
  crosshair: [
    "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z",
    "M12 2v3.4", "M12 18.6V22", "M2 12h3.4", "M18.6 12H22",
    "M12 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  ],
  results: ["M6 20v-6", "M12 20V4", "M18 20V10"],
  history: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3.2 2"],
  calibration: [
    "M4 7h9", "M17 7h3", "M15 4.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z",
    "M4 17h3", "M11 17h9", "M9 14.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z",
  ],
  diagnostics: ["M2.5 12h4l3 7.5 5-15 3 7.5h4"],
  pulse: ["M2.5 12h4l3 7.5 5-15 3 7.5h4"],
  data: [
    "M12 2.8c4.4 0 8 1.2 8 2.7s-3.6 2.7-8 2.7-8-1.2-8-2.7 3.6-2.7 8-2.7Z",
    "M4 5.5v13c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7v-13",
    "M4 12c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7",
  ],
  storage: [
    "M4 5h16v6H4z", "M4 13h16v6H4z", "M7.5 8h.01", "M7.5 16h.01",
  ],
  play: ["M8.5 5.5v13l10-6.5z"],
  pause: ["M9 5v14", "M15 5v14"],
  check: ["M4.5 12.5l5 5L19.5 7"],
  warn: ["M12 3.5 2.5 20h19Z", "M12 9.5v5", "M12 17.4h.01"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5.5", "M12 7.6h.01"],
  mouse: ["M12 2.8a5.2 5.2 0 0 1 5.2 5.2v8a5.2 5.2 0 0 1-10.4 0V8A5.2 5.2 0 0 1 12 2.8Z", "M12 6.5v3.5"],
  monitor: ["M3 4.5h18v12.5H3z", "M8.5 21h7", "M12 17v4"],
  zap: ["M13 2.5 4 14h6.5L11 21.5 20 10h-6.5z"],
  download: ["M12 3.5v11", "M7.5 10 12 14.5 16.5 10", "M4 20.5h16"],
  upload: ["M12 14.5v-11", "M7.5 8 12 3.5 16.5 8", "M4 20.5h16"],
  "arrow-right": ["M4 12h15", "M13 6l6 6-6 6"],
  shield: ["M12 2.8 20 6v6.2c0 5-3.3 8-8 9.2-4.7-1.2-8-4.2-8-9.2V6Z"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3.2 2"],
  settings: [
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    "M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.4.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.4-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4.9 2-3.4Z",
  ],
  flag: ["M5 21V4", "M5 4c4-2.4 8 2.4 12 0v9c-4 2.4-8-2.4-12 0"],
};

/** Fill-style (rather than stroke) icons. */
const FILLED_ICONS: ReadonlySet<IconName> = new Set(["play"]);

export function icon(name: IconName, size = 18): SVGSVGElement {
  const filled = FILLED_ICONS.has(name);
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: filled ? "currentColor" : "none",
    stroke: filled ? "none" : "currentColor",
    "stroke-width": 1.8,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  });
  for (const d of ICON_PATHS[name]) {
    svg.append(svgEl("path", { d }));
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "accent";

const TONE_ICONS: Record<Tone, IconName> = {
  ok: "check",
  warn: "warn",
  danger: "x",
  info: "info",
  neutral: "info",
  accent: "zap",
};

export function badge(tone: Tone, text: string, opts: { dot?: boolean } = {}): HTMLElement {
  const node = el("span", { class: `badge badge-${tone}` });
  if (opts.dot) node.append(el("span", { class: "badge-dot", "aria-hidden": "true" }));
  else node.append(icon(TONE_ICONS[tone], 13));
  node.append(el("span", { text }));
  return node;
}

export function statusDot(tone: Tone): HTMLElement {
  return el("span", { class: `status-dot tone-${tone}`, "aria-hidden": "true" });
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export interface CardOptions {
  title?: string;
  subtitle?: string;
  icon?: IconName;
  tone?: Tone;
  actions?: HTMLElement[];
  class?: string;
}

export function card(opts: CardOptions, ...body: (Node | string)[]): HTMLElement {
  const node = el("section", { class: `card${opts.class ? ` ${opts.class}` : ""}` });
  if (opts.title) {
    const head = el("header", { class: "card-head" });
    const titleWrap = el("div", { class: "card-title-wrap" });
    if (opts.icon) {
      titleWrap.append(
        el("span", { class: `card-icon${opts.tone ? ` tone-${opts.tone}` : ""}` }, [icon(opts.icon, 16)]),
      );
    }
    const titleCol = el("div", {});
    titleCol.append(el("h3", { class: "card-title", text: opts.title }));
    if (opts.subtitle) titleCol.append(el("p", { class: "card-subtitle", text: opts.subtitle }));
    titleWrap.append(titleCol);
    head.append(titleWrap);
    if (opts.actions?.length) {
      const actionWrap = el("div", { class: "card-actions" });
      actionWrap.append(...opts.actions);
      head.append(actionWrap);
    }
    node.append(head);
  }
  const content = el("div", { class: "card-body" });
  content.append(...body);
  node.append(content);
  return node;
}

export function pageHeader(title: string, subtitle?: string, ...trailing: HTMLElement[]): HTMLElement {
  const head = el("div", { class: "page-header" });
  const col = el("div", {});
  col.append(el("h2", { class: "page-title", text: title }));
  if (subtitle) col.append(el("p", { class: "page-subtitle", text: subtitle }));
  head.append(col);
  if (trailing.length) {
    const wrap = el("div", { class: "page-header-actions" });
    wrap.append(...trailing);
    head.append(wrap);
  }
  return head;
}

export function sectionLabel(text: string): HTMLElement {
  return el("h4", { class: "section-label", text });
}

export function grid(cols: number, ...children: (Node | string)[]): HTMLElement {
  const node = el("div", { class: `grid cols-${cols}` });
  node.append(...children);
  return node;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ButtonOptions {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  type?: "button" | "submit";
  large?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button(label: string, opts: ButtonOptions = {}): HTMLButtonElement {
  const node = el("button", {
    class: `btn btn-${opts.variant ?? "secondary"}${opts.large ? " btn-large" : ""}`,
    type: opts.type ?? "button",
  });
  if (opts.icon) node.append(icon(opts.icon, opts.large ? 18 : 15));
  node.append(el("span", { text: label }));
  if (opts.onClick) node.addEventListener("click", opts.onClick);
  return node;
}

export interface FieldOptions {
  hint?: string;
  /** Extra class for the wrapping field element. */
  class?: string;
}

export function field(labelText: string, input: HTMLElement, opts: FieldOptions = {}): HTMLElement {
  const wrap = el("div", { class: `field${opts.class ? ` ${opts.class}` : ""}` });
  const label = el("label", { class: "field-label", text: labelText });
  wrap.append(label, input);
  if (opts.hint) wrap.append(el("p", { class: "field-hint", text: opts.hint }));
  return wrap;
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export interface StatOptions {
  unit?: string;
  sub?: string;
  tone?: Tone;
  large?: boolean;
}

export function statTile(label: string, value: string, opts: StatOptions = {}): HTMLElement {
  const node = el("div", { class: `stat${opts.large ? " stat-large" : ""}` });
  node.append(el("p", { class: "stat-label", text: label }));
  const valueWrap = el("p", { class: `stat-value${opts.tone ? ` tone-${opts.tone}` : ""}` });
  valueWrap.append(el("span", { class: "stat-number", text: value }));
  if (opts.unit) valueWrap.append(el("span", { class: "stat-unit", text: opts.unit }));
  node.append(valueWrap);
  if (opts.sub) node.append(el("p", { class: "stat-sub", text: opts.sub }));
  return node;
}

export function kvList(rows: [string, string | Node][]): HTMLElement {
  const list = el("dl", { class: "kv" });
  for (const [key, value] of rows) {
    const row = el("div", { class: "kv-row" });
    row.append(el("dt", { text: key }));
    const dd = el("dd", {});
    dd.append(value);
    row.append(dd);
    list.append(row);
  }
  return list;
}

export interface TableSpec {
  head: string[];
  rows: (Node | string)[][];
  /** Message shown as a single spanning row when rows is empty. */
  emptyText?: string;
  class?: string;
}

export function table(spec: TableSpec): HTMLElement {
  const wrap = el("div", { class: `table-wrap${spec.class ? ` ${spec.class}` : ""}` });
  const node = el("table", { class: "table" });
  const thead = el("thead", {});
  const headRow = el("tr", {});
  for (const h of spec.head) headRow.append(el("th", { text: h }));
  thead.append(headRow);
  const tbody = el("tbody", {});
  if (spec.rows.length === 0 && spec.emptyText) {
    const tr = el("tr", { class: "table-empty" });
    tr.append(el("td", { colspan: String(spec.head.length), text: spec.emptyText }));
    tbody.append(tr);
  }
  for (const cells of spec.rows) {
    const tr = el("tr", {});
    for (const cell of cells) {
      const td = el("td", {});
      td.append(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  node.append(thead, tbody);
  wrap.append(node);
  return wrap;
}

// ---------------------------------------------------------------------------
// Meters / progress
// ---------------------------------------------------------------------------

/** Horizontal meter for an engine-produced 0..1 value (e.g. confidence). */
export function meter(fraction: number, opts: { tone?: Tone; label?: string } = {}): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  const node = el("div", {
    class: "meter",
    role: "img",
    "aria-label": opts.label ?? `${Math.round(clamped * 100)} percent`,
  });
  const fill = el("div", { class: `meter-fill tone-${opts.tone ?? "accent"}` });
  fill.style.width = `${(clamped * 100).toFixed(1)}%`;
  node.append(fill);
  return node;
}

export interface RangeMarker {
  value: number;
  label: string;
  tone?: Tone;
}

/**
 * Renders an engine-produced plausible range on a linear scale with labeled
 * markers (e.g. current vs recommended eDPI). Purely presentational scaling.
 */
export function rangeBar(
  range: { min: number; max: number },
  markers: RangeMarker[],
  format: (v: number) => string,
): HTMLElement {
  const values = [range.min, range.max, ...markers.map((m) => m.value)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = span * 0.08;
  const scaleLo = lo - pad;
  const scaleSpan = span + pad * 2;
  const pct = (v: number): number => ((v - scaleLo) / scaleSpan) * 100;

  const node = el("div", { class: "range-bar" });
  const track = el("div", { class: "range-track" });
  const band = el("div", { class: "range-band" });
  band.style.left = `${pct(range.min).toFixed(2)}%`;
  band.style.width = `${(pct(range.max) - pct(range.min)).toFixed(2)}%`;
  track.append(band);
  for (const m of markers) {
    const mark = el("div", { class: `range-marker tone-${m.tone ?? "neutral"}` });
    mark.style.left = `${pct(m.value).toFixed(2)}%`;
    track.append(mark);
  }
  node.append(track);

  const legend = el("div", { class: "range-legend" });
  legend.append(
    el("span", { class: "range-end", text: format(range.min) }),
    el("span", { class: "range-caption", text: "plausible range" }),
    el("span", { class: "range-end", text: format(range.max) }),
  );
  node.append(legend);

  const markerLegend = el("div", { class: "range-marker-legend" });
  for (const m of markers) {
    const entry = el("span", { class: "range-marker-entry" });
    entry.append(
      el("span", { class: `range-marker-swatch tone-${m.tone ?? "neutral"}` }),
      el("span", { text: `${m.label} ${format(m.value)}` }),
    );
    markerLegend.append(entry);
  }
  if (markers.length) node.append(markerLegend);
  return node;
}

// ---------------------------------------------------------------------------
// Charts (hand-rolled inline SVG, engine values rendered verbatim)
// ---------------------------------------------------------------------------

export interface BarRow {
  label: string;
  value: number | null;
  /** Optional ± half-width (e.g. standard error) whisker. */
  se?: number | null;
  highlight?: boolean;
  sub?: string;
}

/** Horizontal bar comparison (e.g. candidate utilities). */
export function barChart(rows: BarRow[], format: (v: number) => string): HTMLElement {
  const values = rows.filter((r) => r.value !== null);
  const node = el("div", { class: "bar-chart" });
  if (values.length === 0) {
    node.append(el("p", { class: "muted", text: "No comparable values." }));
    return node;
  }
  const extents = values.flatMap((r) => [
    r.value! - (r.se ?? 0),
    r.value! + (r.se ?? 0),
  ]);
  const lo = Math.min(...extents, 0);
  const hi = Math.max(...extents, 0);
  const span = hi - lo || 1;
  const pct = (v: number): number => ((v - lo) / span) * 100;

  for (const row of rows) {
    const rowEl = el("div", { class: `bar-row${row.highlight ? " bar-highlight" : ""}` });
    const labelWrap = el("div", { class: "bar-label" });
    labelWrap.append(el("span", { text: row.label }));
    if (row.sub) labelWrap.append(el("span", { class: "bar-sub", text: row.sub }));
    rowEl.append(labelWrap);
    const track = el("div", { class: "bar-track" });
    if (row.value !== null) {
      const zero = pct(0);
      const valuePct = pct(row.value);
      const fill = el("div", { class: "bar-fill" });
      fill.style.left = `${Math.min(zero, valuePct).toFixed(2)}%`;
      fill.style.width = `${Math.abs(valuePct - zero).toFixed(2)}%`;
      track.append(fill);
      if (row.se !== null && row.se !== undefined && row.se > 0) {
        const whisker = el("div", { class: "bar-whisker" });
        whisker.style.left = `${pct(row.value - row.se).toFixed(2)}%`;
        whisker.style.width = `${(pct(row.value + row.se) - pct(row.value - row.se)).toFixed(2)}%`;
        track.append(whisker);
      }
      rowEl.append(track, el("span", { class: "bar-value", text: format(row.value) }));
    } else {
      rowEl.append(track, el("span", { class: "bar-value muted", text: "—" }));
    }
    node.append(rowEl);
  }
  return node;
}

export interface SeriesPoint {
  atIso: string;
  value: number | null;
}

/**
 * Compact trend chart over dated engine values. Renders points verbatim;
 * missing values create gaps rather than interpolated fabrications.
 */
export function trendChart(
  points: SeriesPoint[],
  opts: { height?: number; format?: (v: number) => string } = {},
): HTMLElement {
  const height = opts.height ?? 120;
  const width = 460;
  const padX = 8;
  const padY = 14;
  const fmt = opts.format ?? ((v: number): string => String(Math.round(v * 100) / 100));

  const usable = points
    .filter((p): p is { atIso: string; value: number } => p.value !== null)
    .sort((a, b) => a.atIso.localeCompare(b.atIso));
  const wrap = el("div", { class: "trend-chart" });
  if (usable.length === 0) {
    wrap.append(el("p", { class: "muted", text: "No data yet." }));
    return wrap;
  }

  const times = usable.map((p) => Date.parse(p.atIso));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const values = usable.map((p) => p.value);
  const vLo = Math.min(...values);
  const vHi = Math.max(...values);
  const vSpan = vHi - vLo || Math.abs(vHi) * 0.1 || 1;
  const x = (t: number): number =>
    t1 === t0 ? width / 2 : padX + ((t - t0) / (t1 - t0)) * (width - padX * 2);
  const y = (v: number): number =>
    height - padY - ((v - (vLo - vSpan * 0.08)) / (vSpan * 1.16)) * (height - padY * 2);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "trend-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });

  // Reference gridlines (min/max).
  for (const gy of [y(vHi), y(vLo)]) {
    svg.append(
      svgEl("line", {
        x1: padX, x2: width - padX, y1: gy, y2: gy, class: "trend-grid",
      }),
    );
  }

  if (usable.length > 1) {
    const d = usable
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(Date.parse(p.atIso)).toFixed(1)} ${y(p.value).toFixed(1)}`)
      .join(" ");
    svg.append(svgEl("path", { d, class: "trend-line" }));
    const area =
      `${d} L${x(Date.parse(usable[usable.length - 1]!.atIso)).toFixed(1)} ${height - padY} ` +
      `L${x(Date.parse(usable[0]!.atIso)).toFixed(1)} ${height - padY} Z`;
    svg.append(svgEl("path", { d: area, class: "trend-area" }));
  }
  for (const p of usable) {
    svg.append(
      svgEl("circle", {
        cx: x(Date.parse(p.atIso)).toFixed(1),
        cy: y(p.value).toFixed(1),
        r: 3,
        class: "trend-dot",
      }),
    );
  }
  wrap.append(svg);

  const latest = usable[usable.length - 1]!;
  const legend = el("div", { class: "trend-legend" });
  legend.append(
    el("span", { class: "trend-range", text: `${fmt(vLo)} – ${fmt(vHi)}` }),
    el("span", { class: "trend-latest", text: `latest ${fmt(latest.value)}` }),
  );
  wrap.append(legend);
  return wrap;
}

// ---------------------------------------------------------------------------
// Empty states, dialogs, details
// ---------------------------------------------------------------------------

export function emptyState(
  iconName: IconName,
  title: string,
  body: string,
  action?: HTMLElement,
): HTMLElement {
  const node = el("div", { class: "empty-state" });
  node.append(
    el("div", { class: "empty-icon" }, [icon(iconName, 26)]),
    el("h3", { text: title }),
    el("p", { text: body }),
  );
  if (action) node.append(action);
  return node;
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Modal confirmation via the native <dialog>; resolves the user's choice. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { class: "dialog" });
    const head = el("div", { class: "dialog-head" });
    head.append(
      el("span", { class: `card-icon tone-${opts.danger ? "danger" : "info"}` }, [
        icon(opts.danger ? "warn" : "info", 16),
      ]),
      el("h3", { text: opts.title }),
    );
    const actions = el("div", { class: "dialog-actions" });
    const cancel = button(opts.cancelLabel ?? "Cancel", { variant: "ghost" });
    const confirm = button(opts.confirmLabel, { variant: opts.danger ? "danger" : "primary" });
    cancel.addEventListener("click", () => dialog.close("cancel"));
    confirm.addEventListener("click", () => dialog.close("confirm"));
    actions.append(cancel, confirm);
    dialog.append(head, el("p", { class: "dialog-body", text: opts.body }), actions);
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Informational modal (replaces alert()). */
export function infoDialog(title: string, lines: string[], confirmLabel = "Got it"): Promise<void> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { class: "dialog" });
    const head = el("div", { class: "dialog-head" });
    head.append(
      el("span", { class: "card-icon tone-info" }, [icon("info", 16)]),
      el("h3", { text: title }),
    );
    const body = el("div", { class: "dialog-body" });
    for (const line of lines) body.append(el("p", { text: line }));
    const actions = el("div", { class: "dialog-actions" });
    const ok = button(confirmLabel, { variant: "primary" });
    ok.addEventListener("click", () => dialog.close());
    actions.append(ok);
    dialog.append(head, body, actions);
    dialog.addEventListener("close", () => {
      resolve();
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function detailsBlock(summary: string, ...body: (Node | string)[]): HTMLElement {
  const details = el("details", { class: "details" });
  const summaryEl = el("summary", {});
  summaryEl.append(icon("arrow-right", 13), el("span", { text: summary }));
  details.append(summaryEl);
  const content = el("div", { class: "details-body" });
  content.append(...body);
  details.append(content);
  return details;
}

export function jsonBlock(data: unknown): HTMLElement {
  return el("pre", { class: "json", text: JSON.stringify(data, null, 2) });
}

// ---------------------------------------------------------------------------
// Formatting helpers (presentation only — no domain math)
// ---------------------------------------------------------------------------

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAgo(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
