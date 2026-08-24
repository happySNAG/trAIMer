import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoreBackend } from "./backends.ts";
import { LocalJsonStore } from "./store.ts";

export function createLocalJsonStore(rootDir: string): LocalJsonStore {
  return new LocalJsonStore(new NodeFsBackend(rootDir));
}


export class NodeFsBackend implements StoreBackend {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.#rootDir, relPath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    const abs = join(this.#rootDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }

  async listFiles(relDir: string): Promise<string[]> {
    // Recursive walk: store layouts nest (e.g. trials/<experimentId>/<trial>.json)
    // and callers contractually receive paths RELATIVE to relDir — a flat
    // readdir silently dropped every nested artifact from listings, backups,
    // and trial loads.
    const out: string[] = [];
    const base = join(this.#rootDir, relDir);
    const walk = async (relPrefix: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(join(base, relPrefix), { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && relPrefix === "") {
          return;
        }
        throw err;
      }
      for (const entry of dirents) {
        const childRel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(childRel);
        else if (entry.isFile() && entry.name.endsWith(".json")) out.push(childRel);
      }
    };
    try {
      await walk("");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return out.sort();
  }
}
