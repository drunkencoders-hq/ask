// @ts-check
// Minimal in-memory fs for simulating Windows (C:\...) and macOS paths on any
// host. Implements only what src/setup uses.

/** @param {Record<string, string>} [files] @param {string[]} [dirs] */
export function memfs(files = {}, dirs = []) {
  const f = new Map(Object.entries(files));
  const d = new Set(dirs);
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files: f,
    dirs: d,
    readFileSync(p) {
      if (!f.has(p)) throw enoent(p);
      return f.get(p);
    },
    writeFileSync(p, data) {
      f.set(p, String(data));
    },
    existsSync(p) {
      return f.has(p) || d.has(p);
    },
    mkdirSync(p) {
      d.add(p);
    },
    copyFileSync(a, b) {
      if (!f.has(a)) throw enoent(a);
      f.set(b, f.get(a));
    },
    renameSync(a, b) {
      if (!f.has(a)) throw enoent(a);
      f.set(b, f.get(a));
      f.delete(a);
    },
    rmSync(p) {
      f.delete(p);
    },
    statSync(p) {
      if (f.has(p)) return { isFile: () => true, isDirectory: () => false };
      if (d.has(p)) return { isFile: () => false, isDirectory: () => true };
      throw enoent(p);
    },
    accessSync() {},
    constants: { X_OK: 1 },
  };
}
