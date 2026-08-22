import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import {
  exportExperimentBundle,
  importExperimentBundle,
} from "../../src/persistence/bundle.ts";
import { el, clear, downloadJson } from "./dom.ts";

export async function renderDataView(container: HTMLElement): Promise<void> {
  clear(container);
  container.append(el("h2", { text: "Data" }));

  const backend = new IndexedDbBackend(await openAimLabDb());
  const store = new LocalJsonStore(backend);

  const sessionIds = await store.listSessionIds();
  container.append(el("h3", { text: "Sessions" }));
  const table = el("table", {});
  table.append(
    el("tr", {}, [
      el("th", { text: "Session id" }),
      el("th", { text: "Export" }),
    ]),
  );
  if (sessionIds.length === 0) {
    table.append(el("tr", {}, [el("td", { text: "(no sessions yet)", colspan: "2" })]));
  }
  for (const sessionId of sessionIds) {
    const exportButton = el("button", { text: "export bundle" });
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
        alert(String(err));
      }
    });
    table.append(el("tr", {}, [el("td", { text: sessionId }), exportButton]));
  }
  container.append(table);

  container.append(el("h3", { text: "Import session bundle" }));
  const fileInput = el("input", { type: "file", accept: "application/json" });
  const importStatus = el("p", { class: "note", text: "" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await importExperimentBundle(store, JSON.parse(text));
      importStatus.textContent = `imported ${result.trialsImported} trials into ${result.experimentId}`;
    } catch (err) {
      importStatus.textContent = `import failed: ${String(err)}`;
    }
  });
  container.append(fileInput, importStatus);
}
