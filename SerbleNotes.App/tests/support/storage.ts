/**
 * A `localStorage` for node.
 *
 * The client keeps a few small device-local things there - the empty-folder list, and now the
 * sealed draft of an edit the server has not taken. Every one of those reads is already wrapped in
 * a `try`, so without this the tests would run green while silently exercising the "storage is
 * unavailable" path, and a test asserting that a draft survives the app restarting would fail for
 * a reason that has nothing to do with drafts.
 *
 * What it has to get right is the part the restart test depends on: this outlives any one
 * `VaultStore`, exactly as a browser's storage outlives a page. `resetStorage()` is the equivalent
 * of clearing site data, and belongs in a `beforeEach`.
 */
class MemoryStorage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

const storage = new MemoryStorage();

// `Object.keys(localStorage)` is how the client finds every draft it is holding, and that only
// works on a real Storage because the keys are exposed as own properties. A proxy is the shortest
// way to have both that and the methods.
const exposed = new Proxy(storage, {
  ownKeys: (target) => [...Array(target.length).keys()].map((i) => target.key(i)!),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (target, property) => {
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

(globalThis as { localStorage?: unknown }).localStorage = exposed;

export function resetStorage(): void {
  storage.clear();
}
