import { FileSystemAdapter, Platform, TFile, type Vault } from "obsidian";
import {
  fromVault,
  parent,
  ROOT,
  vaultPath,
  assertUniquePaths,
  localRoot,
  affected,
} from "../utils/paths";
import { hashes } from "../utils/hashing";
import { fingerprint } from "../sync/ReconciliationEngine";
import type { FileState, LocalBackend, Snapshot } from "../sync/types";
export type PathGuard = ((vaultRelative: string) => Promise<void>) & {
  identity?: (vaultRelative: string) => Promise<string | null>;
};
export async function desktopGuard(
  vault: Vault,
  root = ROOT,
): Promise<PathGuard> {
  root = localRoot(root);
  if (!Platform.isDesktopApp) return async () => {};
  if (!(vault.adapter instanceof FileSystemAdapter))
    throw new Error(
      "Unsupported desktop adapter: cannot enforce filesystem boundary",
    );
  // Obsidian loads plugins as CommonJS; lazy require works in its renderer loader.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs: typeof import("node:fs/promises") = require("node:fs/promises");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path: typeof import("node:path") = require("node:path");
  const base = await fs.realpath(vault.adapter.getBasePath());
  const guard: PathGuard = async (p: string) => {
    if (p !== root) fromVault(p, root);
    const pieces = p.split("/").filter(Boolean);
    let current = base;
    for (const piece of pieces) {
      current = path.join(current, piece);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw new Error(
            "Unsupported filesystem object (symbolic link or nonregular file)",
          );
        const real = await fs.realpath(current);
        if (real !== base && !real.startsWith(base + path.sep))
          throw new Error("Filesystem boundary violation");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
    }
  };
  guard.identity = async (p) => {
    await guard(p);
    const stat = await fs.lstat(path.join(base, p));
    return stat.isFile() && stat.ino
      ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
      : null;
  };
  return guard;
}
export class VaultBackend implements LocalBackend {
  private rootPath: string;
  private protectedPath: string | null = null;
  constructor(
    private vault: Vault,
    private guard: PathGuard,
    root = ROOT,
    privateDir?: string,
    private isIgnored: (path: string) => boolean = () => false,
  ) {
    this.rootPath = localRoot(root);
    if (privateDir) {
      const privateRoot = localRoot(privateDir);
      const rootKey = this.rootPath.normalize("NFC").toLocaleLowerCase("en-US"),
        privateKey = privateRoot.normalize("NFC").toLocaleLowerCase("en-US");
      if (rootKey === privateKey || rootKey.startsWith(`${privateKey}/`))
        throw new Error("The plugin's private folder cannot be synchronized");
      if (!rootKey || privateKey.startsWith(`${rootKey}/`))
        this.protectedPath = rootKey
          ? privateRoot.slice(this.rootPath.length + 1)
          : privateRoot;
    }
  }
  private path(path: string): string {
    if (this.isIgnored(path)) throw new Error("Needs Rescan: path is ignored");
    if (this.protectedPath && affected(path, [this.protectedPath]))
      throw new Error("The plugin's private folder cannot be synchronized");
    return vaultPath(path, this.rootPath);
  }
  private async root(): Promise<void> {
    await this.guard(this.rootPath);
    const root = await this.vault.adapter.stat(this.rootPath);
    if (!root || root.type !== "folder")
      throw new Error(
        "Local folder is missing or inaccessible. Create it explicitly; no deletions were inferred.",
      );
  }
  private async inspect(path: string): Promise<FileState | null> {
    const p = this.path(path);
    await this.guard(p);
    const before = await this.vault.adapter.stat(p);
    if (!before) return null;
    if (before.type !== "file")
      throw new Error("Destination is an unsupported object or directory");
    const data = await this.vault.adapter.readBinary(p);
    await this.guard(p);
    const after = await this.vault.adapter.stat(p);
    if (
      !after ||
      before.mtime !== after.mtime ||
      before.size !== after.size ||
      data.byteLength !== after.size
    )
      throw new Error("Needs Rescan: local file changed during read");
    const localId = await this.guard.identity?.(p);
    return {
      path,
      size: after.size,
      modifiedAt: after.mtime,
      hashes: hashes(data),
      ...(localId ? { localId } : {}),
    };
  }
  async scan(): Promise<Snapshot> {
    await this.root();
    const s: Snapshot = {
      files: Object.create(null) as Record<string, FileState>,
      blocked:
        this.protectedPath && !this.isIgnored(this.protectedPath)
          ? [this.protectedPath]
          : [],
      warnings: [],
      scannedAt: Date.now(),
      identity: this.rootPath || ".",
    };
    const queue = [this.rootPath],
      seen = new Set<string>(),
      paths: string[] = [];
    while (queue.length) {
      const dir = queue.shift()!;
      if (
        this.isIgnored(
          dir === this.rootPath ? "" : fromVault(dir, this.rootPath),
        )
      )
        continue;
      if (seen.has(dir)) throw new Error("Repeated local directory");
      seen.add(dir);
      await this.guard(dir);
      const listing = await this.vault.adapter.list(dir);
      for (const p of [...listing.files, ...listing.folders]) {
        const prefix = this.rootPath ? `${this.rootPath}/` : "";
        const candidate = p.slice(prefix.length);
        if (
          !p.startsWith(prefix) ||
          candidate
            .split("/")
            .some(
              (part) =>
                !part || part === "." || part === ".." || part.includes("\\"),
            ) ||
          candidate.split("/").slice(0, -1).join("/") !==
            (dir === this.rootPath ? "" : dir.slice(prefix.length))
        )
          throw new Error(
            "Adapter returned a path outside the requested directory",
          );
        // Match before filename portability checks so ignored unsupported names
        // cannot fail the scan or appear as blocked entries.
        if (this.isIgnored(candidate)) continue;
        const rel = fromVault(p, this.rootPath);
        paths.push(rel);
        if (
          this.protectedPath &&
          (rel.normalize("NFC").toLocaleLowerCase("en-US") ===
            this.protectedPath.normalize("NFC").toLocaleLowerCase("en-US") ||
            rel
              .normalize("NFC")
              .toLocaleLowerCase("en-US")
              .startsWith(
                `${this.protectedPath.normalize("NFC").toLocaleLowerCase("en-US")}/`,
              ))
        )
          continue;
        try {
          await this.guard(p);
        } catch {
          s.blocked.push(rel);
          s.warnings.push(`Unsupported filesystem object: ${rel}`);
          continue;
        }
        const stat = await this.vault.adapter.stat(p);
        if (!stat) throw new Error("Local listing changed during scan; rescan");
        if (stat.type === "folder") queue.push(p);
        else if (stat.type === "file") {
          const f = await this.inspect(rel);
          if (!f) throw new Error("Local file disappeared during scan");
          s.files[rel] = f;
        } else {
          s.blocked.push(rel);
          s.warnings.push(`Unsupported object: ${rel}`);
        }
      }
    }
    assertUniquePaths(paths);
    return s;
  }
  async read(path: string): Promise<ArrayBuffer> {
    await this.root();
    await this.guard(this.path(path));
    return this.vault.adapter.readBinary(this.path(path));
  }
  private async parents(path: string): Promise<void> {
    await this.root();
    this.path(path);
    let p = this.rootPath;
    for (const part of parent(path).split("/").filter(Boolean)) {
      p = p ? `${p}/${part}` : part;
      await this.guard(p);
      const stat = await this.vault.adapter.stat(p);
      if (stat && stat.type !== "folder")
        throw new Error("Destination parent is a file");
      if (!stat) await this.vault.adapter.mkdir(p);
    }
  }
  private async expect(
    path: string,
    expected: FileState | null,
  ): Promise<void> {
    if (fingerprint(await this.inspect(path)) !== fingerprint(expected))
      throw new Error("Needs Rescan: local file or destination changed");
  }
  async write(
    path: string,
    data: ArrayBuffer,
    expected: FileState | null,
  ): Promise<void> {
    await this.parents(path);
    await this.expect(path, expected);
    await this.guard(this.path(path));
    const p = this.path(path),
      file = this.vault.getAbstractFileByPath(p);
    if (file instanceof TFile) await this.vault.modifyBinary(file, data);
    else if (expected) await this.vault.adapter.writeBinary(p, data);
    else if (path.split("/").some((part) => part.startsWith(".")))
      await this.vault.adapter.writeBinary(p, data);
    else await this.vault.createBinary(p, data);
  }
  async rename(
    source: string,
    target: string,
    expected: FileState,
  ): Promise<void> {
    await this.parents(target);
    await this.expect(source, expected);
    if (await this.vault.adapter.exists(this.path(target)))
      throw new Error("Needs Rescan: rename destination occupied");
    await this.guard(this.path(source));
    await this.guard(this.path(target));
    const file = this.vault.getAbstractFileByPath(this.path(source));
    // Vault.rename does not run FileManager.renameFile's Markdown link rewriting.
    if (file instanceof TFile) await this.vault.rename(file, this.path(target));
    else await this.vault.adapter.rename(this.path(source), this.path(target));
  }
  async trash(path: string, expected: FileState): Promise<void> {
    await this.root();
    await this.expect(path, expected);
    await this.guard(this.path(path));
    const file = this.vault.getAbstractFileByPath(this.path(path));
    if (file instanceof TFile) await this.vault.trash(file, false);
    else await this.vault.adapter.trashLocal(this.path(path));
    if (await this.vault.adapter.exists(this.path(path)))
      throw new Error("Local trash verification failed");
  }
}
