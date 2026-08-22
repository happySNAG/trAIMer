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
    try {
      const entries = await readdir(join(this.#rootDir, relDir));
      return entries.filter((f) => f.endsWith(".json")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
