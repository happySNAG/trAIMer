import {
  GAME_PROFILE_REGISTRY,
  GENERIC_PROFILE_ID,
  defaultSelectionFor,
  importCurrentSensitivity,
  matchingMethodOf,
  type GameProfile,
  type GameProfileSelection,
} from "../../src/games/index.ts";
import { availableMatching, conversionUsesFov } from "../../src/games/convert.ts";
import { describeMatching } from "../../src/games/matching.ts";
import { el, clear } from "./dom.ts";
import {
  badge,
  card,
  detailsBlock,
  field,
  grid,
  inlineAlert,
  kvList,
  sectionLabel,
  statTile,
} from "./ui.ts";

/**
 * The player-facing game-profile picker (Game Profile Pass 1, requirement 11).
 *
 * Progressive disclosure, in three layers:
 *
 *   1. one select — "which game?" — and nothing else until a game is picked;
 *   2. the handful of settings that game actually needs, plus a live physical
 *      equivalent of whatever the player is running today;
 *   3. everything about the profile itself (what its numbers mean, where they
 *      came from, when they were last checked) inside a closed details block.
 *
 * Every number rendered here comes from the engine's conversion layer. The
 * view formats; it never converts (docs/UI-CONTRACT.md §4).
 */

export interface GameProfilePanelCallbacks {
  onChange(selection: GameProfileSelection | null): void;
}

const NO_GAME = "";

/** Ids of the last few games the player chose, most recent first. */
const RECENT_KEY = "traimer-recent-game-profiles";
const RECENT_LIMIT = 3;
/** Above this many games the picker grows a filter box. */
const FILTER_THRESHOLD = 6;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience; the selection itself lives in settings.
  }
}

function numberInput(
  id: string,
  value: number | null,
  opts: { min?: number; max?: number; step?: number | null; decimals: number },
): HTMLInputElement {
  const input = el("input", {
    type: "number",
    id,
    step: opts.step !== null && opts.step !== undefined ? String(opts.step) : "any",
    value: value === null ? "" : String(value),
  }) as HTMLInputElement;
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  return input;
}

function readNumber(input: HTMLInputElement): number | null {
  const raw = input.value.trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Renders the picker into `container`, replacing whatever is there.
 *
 * `dpi` is the DPI the setup form currently holds; the panel re-renders when
 * it changes so the physical equivalent is never stale.
 */
export function renderGameProfilePanel(
  container: HTMLElement,
  state: { selection: GameProfileSelection | null; dpi: number },
  callbacks: GameProfilePanelCallbacks,
): void {
  clear(container);

  const selectable = GAME_PROFILE_REGISTRY.selectable();
  const compatibility = state.selection
    ? GAME_PROFILE_REGISTRY.checkSelection({
        profileId: state.selection.profileId,
        profileVersion: state.selection.profileVersion,
      })
    : null;
  const profile: GameProfile | null =
    compatibility && compatibility.status !== "unknown-profile"
      ? compatibility.profile
      : null;

  const select = el("select", { id: "game-profile-select" }) as HTMLSelectElement;

  // The list is organised, not just long (Pass 3, requirement 9): the games
  // the player used most recently first, then every named game
  // alphabetically (the registry's order), then the generic/raw control on
  // its own. A filter box narrows the list by name once it is long enough to
  // need one. Fixture profiles never reach `selectable()`, so they cannot
  // appear here.
  const namedGames = selectable.filter((p) => p.id !== GENERIC_PROFILE_ID);
  const control = selectable.filter((p) => p.id === GENERIC_PROFILE_ID);
  const recentIds = readRecent().filter((id) => namedGames.some((p) => p.id === id));
  const populate = (filterText: string): void => {
    const needle = filterText.trim().toLowerCase();
    const matches = (p: GameProfile): boolean =>
      needle === "" || p.displayName.toLowerCase().includes(needle) || p.id === profile?.id;
    clear(select);
    select.append(
      el("option", { value: NO_GAME, text: "No game selected — physical sensitivity only" }),
    );
    const recent = recentIds
      .map((id) => namedGames.find((p) => p.id === id)!)
      .filter(matches);
    if (recent.length > 0 && needle === "") {
      const group = el("optgroup", { label: "Recently used" });
      for (const p of recent) {
        group.append(el("option", { value: p.id, text: profileOptionLabel(p) }));
      }
      select.append(group);
    }
    const games = el("optgroup", { label: "Games (A–Z)" });
    for (const p of namedGames.filter(matches)) {
      games.append(el("option", { value: p.id, text: profileOptionLabel(p) }));
    }
    if (games.childElementCount > 0) select.append(games);
    const other = el("optgroup", { label: "Other" });
    for (const p of control.filter(matches)) {
      other.append(el("option", { value: p.id, text: p.displayName }));
    }
    if (other.childElementCount > 0) select.append(other);
    select.value = profile?.id ?? NO_GAME;
  };
  populate("");

  select.addEventListener("change", () => {
    const picked = select.value === NO_GAME ? null : GAME_PROFILE_REGISTRY.get(select.value);
    if (picked) rememberRecent(picked.id);
    callbacks.onChange(picked ? defaultSelectionFor(picked) : null);
  });

  const pickerFields: HTMLElement[] = [];
  if (selectable.length > FILTER_THRESHOLD) {
    const filter = el("input", {
      type: "search",
      id: "game-profile-filter",
      placeholder: `Find a game (${namedGames.length} available)`,
      autocomplete: "off",
    }) as HTMLInputElement;
    filter.addEventListener("input", () => populate(filter.value));
    pickerFields.push(
      field("Find a game", filter, {
        hint: "Type part of a name to shorten the list below.",
      }),
    );
  }
  pickerFields.push(
    field("Game", select, {
      hint: "trAIMer measures your aim in physical units. A game profile turns that into the number that game accepts.",
    }),
  );

  const body: (Node | string)[] = [el("div", { class: "form-grid" }, pickerFields)];

  // ---- a saved selection this build reads differently, or not at all ----
  if (compatibility && compatibility.status === "unknown-profile") {
    body.push(inlineAlert("warn", "Saved game profile not available", compatibility.message));
  } else if (compatibility && compatibility.status !== "ok") {
    body.push(
      inlineAlert(
        compatibility.status === "profile-deprecated" ? "warn" : "info",
        compatibility.status === "profile-deprecated"
          ? "This profile is no longer maintained"
          : "The conversion for this game has changed",
        compatibility.message,
      ),
    );
  }

  if (profile) {
    const selection = state.selection!;
    const emit = (patch: Partial<GameProfileSelection>): void => {
      callbacks.onChange({
        ...selection,
        // Re-stamp the definition version: the values below were entered
        // against the profile this build holds, whatever the saved one said.
        profileVersion: profile.profileVersion,
        ...patch,
      });
    };

    // The status is the first thing shown about a chosen game — above its
    // inputs, not below them — so a player never types a value into an
    // experimental profile without having been told what that means
    // (Pass 5, requirement 7). The block is tone-coded by status: an
    // experimental profile is visibly not equivalent to a verified one.
    const pickedBadge = profileStatusBadge(profile);
    if (pickedBadge) {
      body.push(
        el(
          "div",
          {
            id: "game-profile-status",
            class: `profile-status profile-status-${profile.status}`,
            role: "status",
          },
          [
            el("div", { class: "profile-status-head" }, [pickedBadge]),
            el("p", { class: "profile-status-text", text: profileStatusExplanation(profile) }),
          ],
        ),
      );
    }

    const hipEntry = profile.hipfireField.entry;
    const hipInput = numberInput("game-current-hipfire", selection.currentHipfire, {
      min: hipEntry.min,
      max: hipEntry.max,
      step: hipEntry.step,
      decimals: hipEntry.uiDecimals,
    });
    const inputs: HTMLElement[] = [
      field(`Your current ${profile.hipfireField.label.toLowerCase()}`, hipInput, {
        hint: `What you have set in ${profile.displayName} right now. Used to show what you are on today — no calibration needed.`,
      }),
    ];

    let verticalInput: HTMLInputElement | null = null;
    if (profile.axes.independentAxes && profile.axes.verticalField) {
      const vEntry = profile.axes.verticalField.entry;
      verticalInput = numberInput("game-current-vertical", selection.currentVertical, {
        min: vEntry.min,
        max: vEntry.max,
        step: vEntry.step,
        decimals: vEntry.uiDecimals,
      });
      inputs.push(
        field(`Your current ${profile.axes.verticalField.label.toLowerCase()}`, verticalInput, {
          hint: "Leave empty unless you deliberately run vertical differently from horizontal.",
        }),
      );
    }

    // A field of view is asked for only when a conversion path reads it. A
    // game whose FOV changes nothing about its numbers (Apex Legends, or a
    // coefficient the game applies itself) gets no decorative input.
    let fovInput: HTMLInputElement | null = null;
    if (profile.fov.kind === "configurable" && conversionUsesFov(profile)) {
      fovInput = numberInput("game-fov", selection.fovDegrees, {
        min: profile.fov.minDegrees,
        max: profile.fov.maxDegrees,
        step: profile.fov.stepDegrees,
        decimals: 0,
      });
      inputs.push(
        field("Field of view", fovInput, {
          hint: `${profile.fov.minDegrees}–${profile.fov.maxDegrees}. Used for the scoped and aimed-down-sights values.`,
        }),
      );
    }

    body.push(el("div", { class: "form-grid" }, inputs));

    const matchingOptions = availableMatching(profile);
    if (matchingOptions.length > 1) {
      const matchSelect = el("select", { id: "game-matching-select" }) as HTMLSelectElement;
      for (const [index, method] of matchingOptions.entries()) {
        const described = describeMatching(method);
        matchSelect.append(el("option", { value: String(index), text: described.label }));
      }
      const currentMethod = matchingMethodOf(selection);
      const currentIndex = matchingOptions.findIndex(
        (m) =>
          m.kind === currentMethod.kind &&
          (m.coefficient ?? null) === (currentMethod.coefficient ?? null) &&
          (m.axis ?? null) === (currentMethod.axis ?? null),
      );
      matchSelect.value = String(currentIndex >= 0 ? currentIndex : 0);
      const detail = el("p", {
        class: "note",
        text: describeMatching(matchingOptions[currentIndex >= 0 ? currentIndex : 0]!).detail,
      });
      matchSelect.addEventListener("change", () => {
        const picked = matchingOptions[Number(matchSelect.value)]!;
        emit({
          matchingKind: picked.kind,
          matchingCoefficient: picked.coefficient ?? null,
          matchingAxis: picked.axis ?? null,
        });
      });
      body.push(
        sectionLabel("Scoped and aimed-down-sights"),
        el("div", { class: "form-grid" }, [
          field("Match scoped aim by", matchSelect, {
            hint: "There is more than one reasonable answer; pick the one you want.",
          }),
        ]),
        detail,
      );
    }

    // ---- live physical equivalent (requirement 14) ----
    if (selection.currentHipfire !== null && state.dpi > 0) {
      try {
        const imported = importCurrentSensitivity(profile, state.dpi, {
          hipfire: selection.currentHipfire,
          vertical: selection.currentVertical,
          fovDegrees: selection.fovDegrees,
        });
        body.push(
          sectionLabel("What you are on today"),
          el("div", { id: "game-physical-equivalent" }, [
            grid(
              2,
              statTile("Physical equivalent", imported.cmPer360X.toFixed(1), {
                unit: "cm/360",
                sub: "How far your hand moves for one full turn",
              }),
              statTile("At DPI", String(state.dpi), {
                sub: "Change DPI and this number changes with it",
              }),
            ),
          ]),
          el("p", { class: "note", id: "game-current-summary", text: imported.summary }),
        );
      } catch {
        body.push(
          inlineAlert(
            "warn",
            "That sensitivity cannot be converted",
            `Enter a value ${profile.displayName} actually accepts (${hipEntry.min}–${hipEntry.max}${hipEntry.unitSuffix}).`,
          ),
        );
      }
    }

    // ---- layer three: the profile itself ----
    const statusLabel: Record<string, string> = {
      verified: "Verified",
      "partially-verified": "Partly verified — see what it does not cover",
      experimental: "Experimental — unconfirmed against the game",
      deprecated: "Deprecated",
    };
    const provenance: [string, string | Node][] = [
      ["Status", statusLabel[profile.status] ?? profile.status],
      ["What 1.00 means", profile.unitDefinition],
      ["Source", profile.source.title],
      ["Source type", profile.source.type.replace(/-/g, " ")],
      ["Checked against", profile.source.gameVersion ?? "not tied to a game build"],
      ["Last verified", profile.source.verifiedAtIso],
      ["Last reviewed", profile.source.lastReviewedAtIso],
      ["Confidence", profile.source.confidence],
      ["Conversion definition", `v${profile.profileVersion}`],
    ];
    if (profile.source.url) provenance.push(["Reference", referenceLink(profile.source.url)]);
    if (profile.fov.kind === "fixed") {
      provenance.push([
        "Field of view",
        `Fixed at ${profile.fov.degrees}° (${profile.fov.axis.replace(/-/g, " ")}); the game exposes no setting`,
      ]);
    } else if (profile.fov.kind === "configurable" && !conversionUsesFov(profile)) {
      provenance.push([
        "Field of view",
        `${profile.fov.minDegrees}–${profile.fov.maxDegrees}° in the game; it does not change any converted value`,
      ]);
    }
    const details: (Node | string)[] = [kvList(provenance)];
    if (profile.dpi.notes.length > 0) {
      details.push(
        sectionLabel("Assumptions"),
        el(
          "ul",
          { class: "note" },
          profile.dpi.notes.map((n) => el("li", { text: n })),
        ),
      );
    }
    if (profile.source.uncertaintyNotes.length > 0 || profile.knownEdgeCases.length > 0) {
      details.push(
        sectionLabel("What this profile does not cover"),
        el(
          "ul",
          { class: "note" },
          [...profile.source.uncertaintyNotes, ...profile.knownEdgeCases].map((n) =>
            el("li", { text: n }),
          ),
        ),
      );
    }
    body.push(detailsBlock(`About the ${profile.displayName} profile`, ...details));

    // Wire inputs last so every handler sees the finished DOM.
    hipInput.addEventListener("change", () => emit({ currentHipfire: readNumber(hipInput) }));
    verticalInput?.addEventListener("change", () =>
      emit({ currentVertical: readNumber(verticalInput!) }),
    );
    fovInput?.addEventListener("change", () => emit({ fovDegrees: readNumber(fovInput!) }));
  } else {
    body.push(
      el("p", {
        class: "note",
        id: "game-profile-empty",
        text: "Without a game selected, results are reported as a physical sensitivity — centimetres of mouse movement for a full 360° turn — which you can convert yourself.",
      }),
    );
  }

  container.append(
    card(
      {
        title: "Game sensitivity",
        subtitle: "Turn the recommendation into the number your game accepts",
        icon: "target",
      },
      ...body,
    ),
  );
}

/**
 * The one sentence that says what a profile's status MEANS for this game
 * (Game Profile Pass 4, requirement 22).
 *
 * A status word on its own is a label, not information: "partly verified"
 * tells a player nothing about whether the number they are about to type is
 * one of the trusted ones. So the badge is followed by the profile's own
 * first stated limitation, verbatim — those sentences are already written
 * for players, and quoting one here is what turns the badge into an answer.
 * The full list stays in the details block; this is the headline.
 */
export function profileStatusExplanation(profile: {
  status: string;
  knownEdgeCases: readonly string[];
  source: { uncertaintyNotes: readonly string[] };
}): string {
  const first =
    profile.knownEdgeCases[0] ?? profile.source.uncertaintyNotes[0] ?? null;
  const tail = first ? ` What it does not cover: ${first}` : "";
  switch (profile.status) {
    case "partially-verified":
      return `Hip-fire conversion is well supported; some scoped behaviour is not.${tail}`;
    case "experimental":
      return `Its numbers have not been confirmed against the game, so every converted value carries that warning. You can still use it: treat the number as a starting point and check it in the game before trusting it.${tail}`;
    case "deprecated":
      return `This profile is no longer recommended.${tail}`;
    default:
      return "";
  }
}

/** The badge a profile's status earns on the results screen. */
export function profileStatusBadge(profile: {
  status: string;
}): HTMLElement | null {
  if (profile.status === "verified") return null;
  if (profile.status === "experimental") return badge("warn", "Experimental profile");
  if (profile.status === "deprecated") return badge("danger", "Deprecated profile");
  return badge("info", "Partly verified");
}

/**
 * The name a profile is listed under in the picker.
 *
 * An experimental profile says so IN THE LIST, not only after it has been
 * chosen: a player scanning for their game sees the qualification at the
 * same moment they see the name (Pass 5, requirement 7). Partly verified
 * profiles are the common case and are explained once chosen, where there is
 * room to say what "partly" means for that game.
 */
export function profileOptionLabel(profile: { displayName: string; status: string }): string {
  return profile.status === "experimental"
    ? `${profile.displayName} (experimental)`
    : profile.displayName;
}

/**
 * A provenance URL rendered as a link a player can actually follow.
 *
 * trAIMer never fetches this itself: in the desktop shell the click is handed
 * to the system browser by the window-open handler, and in a browser it opens
 * a new tab. Either way the app makes no request — the no-telemetry audit's
 * allowance covers the string, not any traffic.
 */
export function referenceLink(url: string): HTMLElement {
  const link = el("a", {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    class: "reference-link",
    text: url,
  });
  return link;
}
