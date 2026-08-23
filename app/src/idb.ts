import type { MinimalIdbLike } from "../../src/persistence/backends.ts";

export function openAimLabDb(dbName = "aldo-aim-lab"): Promise<MinimalIdbLike> {
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
