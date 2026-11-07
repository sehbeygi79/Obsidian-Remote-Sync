export const ROOT = "materials";
export function segment(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/]/u.test(name) ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("Unsafe filename");
  // Reject names that cannot roundtrip on supported device filesystems.
  if (
    /[<>:"|?*]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(name)
  )
    throw new Error("Unsupported filename");
  return name;
}
export function relative(path: string): string {
  if (typeof path !== "string" || path.length > 4096)
    throw new Error("Invalid path");
  path.split("/").forEach(segment);
  return path;
}
export function localRoot(path: string): string {
  if (path === "." || path === "./" || path === "") return "";
  if (path.startsWith("./")) path = path.slice(2);
  return relative(path.endsWith("/") ? path.slice(0, -1) : path);
}
export function vaultPath(path: string, root = ROOT): string {
  root = localRoot(root);
  return root ? `${root}/${relative(path)}` : relative(path);
}
export function fromVault(path: string, root = ROOT): string {
  root = localRoot(root);
  if (!root) return relative(path);
  if (!path.startsWith(`${root}/`))
    throw new Error("Path outside local folder");
  return relative(path.slice(root.length + 1));
}
export function parent(path: string): string {
  relative(path);
  return path.split("/").slice(0, -1).join("/");
}
export function basename(path: string): string {
  return relative(path).split("/").at(-1)!;
}
export function affected(path: string, blocked: string[]): boolean {
  path = path.normalize("NFC").toLocaleLowerCase("en-US");
  return blocked.some((entry) => {
    const p = entry.normalize("NFC").toLocaleLowerCase("en-US");
    return (
      p === "" ||
      path === p ||
      path.startsWith(`${p}/`) ||
      p.startsWith(`${path}/`)
    );
  });
}
export function assertUniquePaths(paths: string[]): void {
  const seen = new Set<string>();
  for (const p of paths) {
    relative(p);
    const key = p.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error("Case or Unicode path collision");
    seen.add(key);
  }
}
