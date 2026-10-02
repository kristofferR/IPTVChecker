// Bun has no localStorage, and the store reads it at module load. Tests that
// need real storage behaviour install their own.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    length: 0,
    clear() {},
    getItem: () => null,
    key: () => null,
    removeItem() {},
    setItem() {},
  } satisfies Storage,
});
