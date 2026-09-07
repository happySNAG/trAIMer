import type { MinimalIdbLike } from "../../src/persistence/backends.ts";

/**
 * The IndexedDB database holding every trial, session, recommendation and
 * calibration record this player has ever produced.
 *
 * THE NAME IS DELIBERATELY NOT RENAMED with the product (Pass 13). An
 * IndexedDB database is addressed by (origin, name): opening "traimer"
 * instead of "aldo-aim-lab" would silently create a brand-new empty database
 * and present an existing player with no history at all, while their real
 * data sat on disk under the old name, unreachable from the UI.
 *
 * IndexedDB has no rename operation, so the alternatives were "copy every
 * record across on first launch" (slow, and a partial copy is worse than no
 * copy) or "keep the name". The name is invisible: it appears in no UI, no
 * export, and no document the player will ever read. It is allowlisted in the
 * branding gate for exactly this reason (scripts/verify-branding.mjs).
 */
export const TRAINING_DB_NAME = "aldo-aim-lab";

export function openTraimerDb(dbName = TRAINING_DB_NAME): Promise<MinimalIdbLike> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("kv")) {
        request.result.createObjectStore("kv");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        get(key: string) {
          return wrap(db, "readonly", (store) => store.get(key));
        },
        put(key: string, value: string) {
          return wrap(db, "readwrite", (store) => store.put(value, key));
        },
        async getAllKeys() {
          const keys = await wrap(db, "readonly", (store) => store.getAllKeys());
          return keys.map((k) => String(k));
        },
      });
    };
  });
}

function wrap<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const request = action(tx.objectStore("kv"));
    request.onerror = () => {
      const err = request.error ?? new Error("IndexedDB request failed");
      reject(err);
    };
    request.onsuccess = () => resolve(request.result);
  });
}
