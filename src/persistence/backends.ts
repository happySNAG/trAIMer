export interface StoreBackend {
  readFile(relPath: string): Promise<string | null>;
  writeFile(relPath: string, contents: string): Promise<void>;
  listFiles(relDir: string): Promise<string[]>;
}

export class InMemoryBackend implements StoreBackend {
  readonly #files = new Map<string, string>();

  async readFile(relPath: string): Promise<string | null> {
    return this.#files.get(relPath) ?? null;
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    this.#files.set(relPath, contents);
  }

  async listFiles(relDir: string): Promise<string[]> {
    const prefix = relDir.endsWith("/") ? relDir : `${relDir}/`;
    return [...this.#files.keys()]
      .filter((k) => k.startsWith(prefix) && k.endsWith(".json"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
}

export interface MinimalIdbLike {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<unknown>;
  getAllKeys(): Promise<string[]>;
}

export class IndexedDbBackend implements StoreBackend {
  readonly #db: MinimalIdbLike;

  constructor(db: MinimalIdbLike) {
    this.#db = db;
  }

  async readFile(relPath: string): Promise<string | null> {
    const value = await this.#db.get(relPath);
    return value ?? null;
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    await this.#db.put(relPath, contents);
  }

  async listFiles(relDir: string): Promise<string[]> {
    const keys = await this.#db.getAllKeys();
    const prefix = relDir.endsWith("/") ? relDir : `${relDir}/`;
    return keys
      .filter((k) => k.startsWith(prefix) && k.endsWith(".json"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
}
