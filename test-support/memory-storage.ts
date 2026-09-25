/**
 * An in-memory `Storage` for component tests that read the page's
 * `localStorage`. Under vitest's jsdom environment `window` is the Node global,
 * and Node 26 defines its own `localStorage` there, which is undefined unless
 * the process was started with `--localstorage-file`. Install one per test
 * with `vi.stubGlobal("localStorage", new MemoryStorage())`.
 */
export class MemoryStorage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}
