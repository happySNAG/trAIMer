import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import {
  exportExperimentBundle,
  importExperimentBundle,
} from "../../src/persistence/bundle.ts";
import { exportBackupAll, importBackupAll } from "../../src/persistence/backup.ts";
import { el, clear, downloadJson } from "./dom.ts";
import {
  button,
  card,
  confirmDialog,
  grid,
  pageHeader,
  sectionLabel,
  table,
} from "./ui.ts";

export async function renderDataView(container: HTMLElement): Promise<void> {
  clear(container);
  container.append(
    pageHeader(
      "Data",
      "Your measurements belong to you: everything lives in this browser's local storage. Back up, move, or share sessions from here.",
    ),
  );

  const backend = new IndexedDbBackend(await openAimLabDb());
  const store = new LocalJsonStore(backend);

  // ---- whole-store backup ----
  const backupStatus = el("p", { class: "note", text: "" });
  const backupBtn = button("Back up all data", { variant: "primary", icon: "download" });
  backupBtn.addEventListener("click", async () => {
    backupStatus.textContent = "Building backup…";
    try {
      const backup = await exportBackupAll(backend);
      downloadJson(`aldo-aim-lab-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
      backupStatus.className = "tone-ok";
      backupStatus.textContent = `Backup created — ${backup.entryPaths.length} artifacts with SHA-256 integrity.`;
    } catch (err) {
      backupStatus.className = "tone-danger";
      backupStatus.textContent = `Backup failed: ${String(err)}`;
    }
  });

  container.append(
    grid(
      2,
      card(
        {
          title: "Back up all data",
          subtitle: "One file containing every session, trial, result, and calibration",
          icon: "download",
        },
        el("p", {
          class: "muted",
          text: "The backup carries a SHA-256 integrity checksum. Keep a copy anywhere you like — nothing is uploaded.",
        }),
        el("div", {}, [backupBtn]),
        backupStatus,
      ),
      buildSessionExportCard(store, backend),
    ),
  );

  // ---- import session bundle ----
  container.append(sectionLabel("Import"));
  const importStatus = el("p", { class: "note", text: "" });
  const fileInput = el("input", { type: "file", accept: "application/json" });
  fileInput.addEventListener("change", async () => {
    const file = (fileInput as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await importExperimentBundle(store, JSON.parse(text));
      importStatus.className = "tone-ok";
      importStatus.textContent = `Imported ${result.trialsImported} trials into ${result.experimentId}.`;
    } catch (err) {
      importStatus.className = "tone-danger";
      importStatus.textContent = `import failed: ${String(err)}`;
    }
  });
  container.append(
    card(
      {
        title: "Import session bundle",
        subtitle: "Load a previously exported session — validated fully before anything is written",
        icon: "upload",
      },
      fileInput,
      importStatus,
    ),
  );

  // ---- danger zone: full restore ----
  container.append(sectionLabel("Danger zone"));
  const restoreStatus = el("p", { class: "note", text: "" });
  const restoreInput = el("input", { type: "file", accept: "application/json", class: "hidden" }) as HTMLInputElement;
  restoreInput.addEventListener("change", async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = "";
    if (!file) return;
    const confirmed = await confirmDialog({
      title: "Restore from backup?",
      body: `Artifacts from "${file.name}" will be written into local storage, overwriting entries at the same paths. The file is fully validated (checksum, schemas, path safety) before a single byte is written.`,
      confirmLabel: "Restore backup",
      danger: true,
    });
    if (!confirmed) return;
    restoreStatus.textContent = "Validating backup…";
    try {
      const text = await file.text();
      const result = await importBackupAll(backend, JSON.parse(text));
      restoreStatus.className = "tone-ok";
      restoreStatus.textContent = `Restored ${result.restoredCount} artifacts${result.skippedPaths.length > 0 ? ` · ${result.skippedPaths.length} skipped` : ""}.`;
    } catch (err) {
      restoreStatus.className = "tone-danger";
      restoreStatus.textContent = `Restore failed — nothing was written: ${String(err)}`;
    }
  });
  const restoreBtn = button("Restore from backup…", { variant: "danger", icon: "upload" });
  restoreBtn.addEventListener("click", () => restoreInput.click());

  const dangerCard = el("section", { class: "danger-zone card" });
  const dangerBody = el("div", { class: "card-body" });
  dangerBody.append(
    el("div", { class: "danger-row" }, [
      el("div", { class: "danger-row-text" }, [
        el("span", { class: "danger-row-title", text: "Restore all data from a backup file" }),
        el("span", {
          class: "danger-row-sub",
          text: "Overwrites artifacts at matching paths. A corrupted or tampered file is rejected before any write — zero partial state.",
        }),
      ]),
      restoreBtn,
    ]),
    restoreInput,
    restoreStatus,
  );
  dangerCard.append(dangerBody);
  container.append(dangerCard);
}

function buildSessionExportCard(store: LocalJsonStore, backend: IndexedDbBackend): HTMLElement {
  const holder = card(
    {
      title: "Export a single session",
      subtitle: "Portable bundle for one experiment — shareable and re-importable",
      icon: "data",
    },
  );
  const body = holder.querySelector<HTMLElement>(".card-body");
  void (async () => {
    const sessionIds = await store.listSessionIds();
    if (!body) return;
    body.append(
      table({
        head: ["Session", "Export"],
        rows: sessionIds.map((sessionId) => {
          const exportButton = button("Export bundle", { variant: "ghost", icon: "download" });
          exportButton.addEventListener("click", async () => {
            try {
              const raw = await backend.readFile(`sessions/${sessionId}.json`);
              if (!raw) return;
              const session = JSON.parse(raw) as {
                payload: { experimentId: string | null };
              };
              const experimentId = session.payload.experimentId;
              if (!experimentId) throw new Error("session has no experiment");
              const bundle = await exportExperimentBundle(store, experimentId);
              downloadJson(`${experimentId}-bundle.json`, bundle);
            } catch (err) {
              const note = el("p", { class: "tone-danger note", text: String(err) });
              body.append(note);
            }
          });
          return [el("span", { class: "mono", text: sessionId }), exportButton];
        }),
        emptyText: "No sessions stored yet.",
      }),
    );
  })();
  return holder;
}
