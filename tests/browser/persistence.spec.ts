import { expect, test } from "@playwright/test";

test.describe("persistence failure states", () => {
  test("importing a malformed bundle surfaces an error instead of corrupting state", async ({
    page,
  }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);

    // Create a malformed bundle file and feed it through the import input.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('#view-data button', { hasText: "Choose bundle file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "broken-bundle.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ kind: "not-a-bundle", payload: {} })),
    });

    await expect(page.locator("#view-data")).toContainText("Import rejected", {
      timeout: 10_000,
    });
  });

  test("importing a future-schema bundle is rejected loudly", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator('#view-data button', { hasText: "Choose bundle file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "future-bundle.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ kind: "session-bundle", schemaVersion: 99, payload: {} }),
      ),
    });
    await expect(page.locator("#view-data")).toContainText("Import rejected", {
      timeout: 10_000,
    });
  });
});

test.describe("resume checkpoint UI", () => {
  test("incomplete sessions are listed with Resume/Discard/Export actions", async ({
    page,
  }) => {
    // Seed a checkpoint envelope directly into IndexedDB before app boot.
    await page.addInitScript(() => {
      const checkpoint = {
        schemaVersion: 2,
        kind: "session-resume",
        sessionId: "session-e2e-resume",
        experimentId: "experiment-e2e-resume",
        status: "running",
        updatedAtIso: new Date().toISOString(),
        createdAtIso: new Date().toISOString(),
        completedSequenceKeys: ["0:0", "0:1"],
        currentRound: 0,
        phaseLog: [{ state: "setup", tIso: new Date().toISOString() }],
        activeTestingMs: 40000,
        continuousTestingMs: 12000,
        restCount: 1,
        blindedLabels: { "cand-a": "Candidate A" },
        repCounterByCandidate: { "cand-a": 1 },
        completedTrialIds: ["trial-x"],
        auditTrail: [],
        captureSource: null,
        playerId: null,
        playerName: "E2EPlayer",
        dpi: 800,
        retestOfExperimentId: null,
        calibrationRecordIdsX: [],
        calibrationRecordIdsY: [],
        appVersion: "test",
        engineVersion: "engine-v4",
        optimizerVersion: "optimizer-v3",
        interruptedTrial: null,
        lastValidState: "inter-trial",
      };
      void checkpoint; // real seeding happens after app boot below
    });

    // The real seeding happens through the app's own DB below.
    await page.goto("/?e2e=1");
    await page.evaluate(async () => {
      const checkpoint = {
        schemaVersion: 2,
        kind: "session-resume",
        sessionId: "session-e2e-resume",
        experimentId: "experiment-e2e-resume",
        status: "running",
        updatedAtIso: new Date().toISOString(),
        createdAtIso: new Date().toISOString(),
        completedSequenceKeys: ["0:0", "0:1"],
        currentRound: 0,
        phaseLog: [{ state: "setup", tIso: new Date().toISOString() }],
        activeTestingMs: 40000,
        continuousTestingMs: 12000,
        restCount: 1,
        blindedLabels: { "cand-a": "Candidate A" },
        repCounterByCandidate: { "cand-a": 1 },
        completedTrialIds: ["trial-x"],
        auditTrail: [],
        captureSource: null,
        playerId: null,
        playerName: "E2EPlayer",
        dpi: 800,
        retestOfExperimentId: null,
        calibrationRecordIdsX: [],
        calibrationRecordIdsY: [],
        appVersion: "test",
        engineVersion: "engine-v4",
        optimizerVersion: "optimizer-v3",
        interruptedTrial: null,
        lastValidState: "inter-trial",
      };
      const envelope = JSON.stringify({
        schemaVersion: 1,
        kind: "session-checkpoint",
        savedAtIso: new Date().toISOString(),
        payload: checkpoint,
      });
      await new Promise<void>((resolve) => {
        const req = indexedDB.open("aldo-aim-lab", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("kv")) {
            req.result.createObjectStore("kv");
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put(envelope, "sessions/checkpoints/session-e2e-resume.json");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    });

    // Reload so the startup resume list picks it up (Home shows it first-class).
    await page.reload();
    const resumeList = page.locator("#view-home .resume-list");
    await expect(resumeList.locator('[data-role="checkpoint"]')).toBeVisible({ timeout: 15_000 });
    await expect(resumeList).toContainText("E2EPlayer");
    await expect(resumeList).toContainText("Resume");
    await expect(resumeList).toContainText("Discard");
    await expect(resumeList).toContainText("Export session bundle");

    // Discard (with confirmation) marks the checkpoint aborted and clears the
    // list after the automatic reload.
    await resumeList.locator("button", { hasText: "Discard" }).first().click();
    await page.locator(".dialog button", { hasText: "Discard session" }).click();
    await expect(page.locator('#view-home .resume-list [data-role="checkpoint"]')).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});
