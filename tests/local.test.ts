import { describe, it, expect, vi } from "vitest";
import type { Vault } from "obsidian";
import { TFile, Platform, FileSystemAdapter } from "obsidian";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultBackend, desktopGuard } from "../src/local/VaultBackend";
import { hashes } from "../src/utils/hashing";
import { bytes } from "./helpers";
import { fromVault, localRoot, relative, vaultPath } from "../src/utils/paths";
import { reconcile } from "../src/sync/ReconciliationEngine";
function tfile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  return f;
}
function fixture(indexed = true) {
  const data = new Map<string, ArrayBuffer>([
      ["materials/a.md", bytes("text")],
      ["materials/.hidden", bytes("hidden")],
      ["Notes/outside.md", bytes("untouched")],
    ]),
    dirs = new Set(["", "materials", "Notes"]);
  const adapter = {
    stat: vi.fn(async (p: string) =>
      data.has(p)
        ? { type: "file", size: data.get(p)!.byteLength, mtime: 1000, ctime: 1 }
        : dirs.has(p)
          ? { type: "folder", mtime: 1, ctime: 1, size: 0 }
          : null,
    ),
    list: vi.fn(async (p: string) => ({
      files: [...data.keys()].filter(
        (k) =>
          k.startsWith(p ? `${p}/` : "") &&
          !k.slice(p ? p.length + 1 : 0).includes("/"),
      ),
      folders: [...dirs].filter(
        (k) =>
          k !== p &&
          k.startsWith(p ? `${p}/` : "") &&
          !k.slice(p ? p.length + 1 : 0).includes("/"),
      ),
    })),
    exists: vi.fn(async (p: string) => data.has(p) || dirs.has(p)),
    readBinary: vi.fn(async (p: string) => data.get(p)!.slice(0)),
    writeBinary: vi.fn(async (p: string, b: ArrayBuffer) => {
      data.set(p, b);
    }),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(p);
    }),
    rename: vi.fn(async (a: string, b: string) => {
      data.set(b, data.get(a)!);
      data.delete(a);
    }),
    trashLocal: vi.fn(async (p: string) => {
      data.delete(p);
    }),
  };
  const vault = {
    adapter,
    getAbstractFileByPath: (p: string) =>
      indexed && data.has(p) ? tfile(p) : null,
    modifyBinary: vi.fn(async (f: TFile, b: ArrayBuffer) => {
      data.set(f.path, b);
    }),
    createBinary: vi.fn(async (p: string, b: ArrayBuffer) => {
      if (data.has(p)) throw new Error("exists");
      data.set(p, b);
      return tfile(p);
    }),
    rename: vi.fn(async (f: TFile, p: string) => {
      data.set(p, data.get(f.path)!);
      data.delete(f.path);
    }),
    trash: vi.fn(async (f: TFile, _system: boolean) => {
      data.delete(f.path);
    }),
    fileManager: { renameFile: vi.fn() },
  };
  const guard = vi.fn(async (_p: string) => {}),
    backend = new VaultBackend(vault as unknown as Vault, guard);
  return { data, dirs, adapter, vault, guard, backend };
}
describe("materials boundary", () => {
  it("skips ignored subtrees before reading and refuses direct operations on ignored files", async () => {
    const f = fixture();
    f.dirs.add("materials/private");
    f.data.set("materials/private/secret.md", bytes("secret"));
    f.data.set("materials/unsupported:name", bytes("ignored"));
    const ignored = (path: string) =>
      path === "private" ||
      path.startsWith("private/") ||
      path === ".hidden" ||
      path === "unsupported:name";
    const backend = new VaultBackend(
      f.vault as unknown as Vault,
      f.guard,
      "materials",
      undefined,
      ignored,
    );
    const scan = await backend.scan();
    expect(Object.keys(scan.files)).toEqual(["a.md"]);
    expect(scan.blocked).toEqual([]);
    expect(f.adapter.list.mock.calls.flat()).not.toContain("materials/private");
    expect(f.adapter.readBinary.mock.calls.flat()).not.toContain(
      "materials/private/secret.md",
    );
    await expect(backend.read("private/secret.md")).rejects.toThrow("ignored");
    await expect(
      backend.write("private/new.md", bytes("new"), null),
    ).rejects.toThrow("ignored");
    await expect(
      backend.rename("a.md", "private/moved.md", scan.files["a.md"]!),
    ).rejects.toThrow("ignored");
    await expect(backend.trash(".hidden", scan.files["a.md"]!)).rejects.toThrow(
      "ignored",
    );
  });
  it("normalizes vault root and rejects unsafe folder paths", () => {
    expect(localRoot("./")).toBe("");
    expect(localRoot("Notes/Sub/")).toBe("Notes/Sub");
    expect(localRoot("./my_files")).toBe("my_files");
    expect(localRoot("./Notes/Sub/")).toBe("Notes/Sub");
    expect(() => localRoot("../outside")).toThrow();
    expect(() => localRoot("./../outside")).toThrow();
    expect(() => localRoot(".//outside")).toThrow();
    expect(() => localRoot("/absolute")).toThrow();
  });
  it("scans the whole vault without exposing plugin private data and blocks remote writes there", async () => {
    const f = fixture();
    const privateDir = ".obsidian/plugins/obsidian-remote-sync/private";
    for (const d of [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/obsidian-remote-sync",
      privateDir,
    ])
      f.dirs.add(d);
    f.data.set(`${privateDir}/credentials.json`, bytes("private"));
    const backend = new VaultBackend(
      f.vault as unknown as Vault,
      f.guard,
      "",
      privateDir,
    );
    const local = await backend.scan();
    expect(Object.keys(local.files)).toEqual(
      expect.arrayContaining(["materials/a.md", "Notes/outside.md"]),
    );
    expect(local.files[`${privateDir}/credentials.json`]).toBeUndefined();
    expect(local.blocked).toContain(privateDir);
    const ignoredConfig = new VaultBackend(
      f.vault as unknown as Vault,
      f.guard,
      "",
      privateDir,
      (path) => path === ".obsidian" || path.startsWith(".obsidian/"),
    );
    const ignoredScan = await ignoredConfig.scan();
    expect(ignoredScan.blocked).toEqual([]);
    expect(
      Object.keys(ignoredScan.files).some((path) =>
        path.startsWith(".obsidian/"),
      ),
    ).toBe(false);
    await expect(
      backend.write(`${privateDir}/credentials.json`, bytes("overwrite"), null),
    ).rejects.toThrow("private");
    await expect(
      backend.write(
        `${privateDir.toUpperCase()}/credentials.json`,
        bytes("overwrite"),
        null,
      ),
    ).rejects.toThrow("private");
    const remote = {
      files: {
        [`${privateDir}/credentials.json`]: {
          path: `${privateDir}/credentials.json`,
          size: 1,
          modifiedAt: 1,
          hashes: {},
        },
      },
      blocked: [],
      warnings: [],
      scannedAt: 0,
      identity: "remote",
    };
    expect(
      reconcile(local, remote, {}).find((c) =>
        c.path.endsWith("credentials.json"),
      )?.category,
    ).toBe("blocked");
    expect(
      () =>
        new VaultBackend(
          f.vault as unknown as Vault,
          f.guard,
          `${privateDir}/child`,
          privateDir,
        ),
    ).toThrow("private");
  });
  it.each([
    "../outside",
    "a/../b",
    "/outside",
    "a\\b",
    "a//b",
    ".",
    "a/./b",
    "C:/file",
    "bad\u0000name",
  ])("rejects traversal/unsafe path %s", (p) =>
    expect(() => relative(p)).toThrow(),
  );
  it("accepts normal hidden and arbitrary extension paths", () => {
    expect(vaultPath(".hidden/file.xyz")).toBe("materials/.hidden/file.xyz");
    expect(fromVault("materials/doc.md")).toBe("doc.md");
  });
  it("rejects vault path outside materials", () =>
    expect(() => fromVault("Notes/a")).toThrow("outside"));
  it("scans all types including hidden files without reading other notes", async () => {
    const f = fixture();
    const s = await f.backend.scan();
    expect(Object.keys(s.files)).toEqual(["a.md", ".hidden"]);
    expect(
      f.adapter.readBinary.mock.calls.every(([p]) =>
        p.startsWith("materials/"),
      ),
    ).toBe(true);
  });
  it("missing root is never a deletion scan", async () => {
    const f = fixture();
    f.dirs.delete("materials");
    await expect(f.backend.scan()).rejects.toThrow("missing");
  });
  it("inaccessible root listing aborts the scan", async () => {
    const f = fixture();
    f.adapter.list.mockRejectedValueOnce(new Error("permissions"));
    await expect(f.backend.scan()).rejects.toThrow("permissions");
  });
  it("unsupported objects are reported and blocked", async () => {
    const f = fixture();
    f.guard.mockImplementation(async (p) => {
      if (p === "materials/a.md") throw new Error("symlink");
    });
    const s = await f.backend.scan();
    expect(s.blocked).toContain("a.md");
    expect(s.files["a.md"]).toBeUndefined();
  });
  it("rejects adapter response escaping root", async () => {
    const f = fixture();
    f.adapter.list.mockResolvedValueOnce({
      files: ["Notes/outside.md"],
      folders: [],
    });
    await expect(f.backend.scan()).rejects.toThrow("outside");
  });
  it("indexed rename calls Vault.rename without file-manager link handling", async () => {
    const f = fixture(),
      s = await f.backend.scan();
    await f.backend.rename("a.md", "nested/new.md", s.files["a.md"]!);
    expect(f.vault.rename).toHaveBeenCalledOnce();
    expect(f.vault.fileManager.renameFile).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(f.data.get("Notes/outside.md"))).toBe(
      "untouched",
    );
  });
  it("hidden rename uses adapter without touching note references", async () => {
    const f = fixture(false),
      s = await f.backend.scan();
    await f.backend.rename(".hidden", ".moved", s.files[".hidden"]!);
    expect(f.adapter.rename).toHaveBeenCalledOnce();
    expect(f.vault.fileManager.renameFile).not.toHaveBeenCalled();
  });
  it("write rechecks destination contents before overwrite", async () => {
    const f = fixture(),
      s = await f.backend.scan();
    f.data.set("materials/a.md", bytes("changed"));
    await expect(
      f.backend.write("a.md", bytes("new"), s.files["a.md"]!),
    ).rejects.toThrow("Needs Rescan");
  });
  it("trash uses recoverable vault trash with no permanent fallback", async () => {
    const f = fixture(),
      s = await f.backend.scan();
    await f.backend.trash("a.md", s.files["a.md"]!);
    expect(f.vault.trash).toHaveBeenCalledWith(expect.any(TFile), false);
  });
  it("trash error is surfaced and file remains intact", async () => {
    const f = fixture(),
      s = await f.backend.scan();
    f.vault.trash.mockRejectedValueOnce(new Error("trash unavailable"));
    await expect(f.backend.trash("a.md", s.files["a.md"]!)).rejects.toThrow(
      "trash unavailable",
    );
    expect(f.data.has("materials/a.md")).toBe(true);
  });
  it("rename collision never overwrites unrelated file", async () => {
    const f = fixture(),
      s = await f.backend.scan();
    await expect(
      f.backend.rename("a.md", ".hidden", s.files["a.md"]!),
    ).rejects.toThrow("occupied");
  });
  it("writes ordinary Markdown as binary without inspecting notes", async () => {
    const f = fixture();
    await f.backend.write("new.md", bytes("[[normal link]]"), null);
    expect(f.data.get("materials/new.md")).toEqual(bytes("[[normal link]]"));
    expect(hashes(f.data.get("Notes/outside.md")!)).toEqual(
      hashes(bytes("untouched")),
    );
  });
  it("desktop guard refuses a symbolic link escaping materials", async () => {
    const temp = await mkdtemp(join(tmpdir(), "remote-sync-guard-"));
    try {
      await mkdir(join(temp, "materials"));
      await writeFile(join(temp, "outside"), "secret");
      await symlink(join(temp, "outside"), join(temp, "materials", "link"));
      const adapter = new FileSystemAdapter();
      vi.spyOn(adapter, "getBasePath").mockReturnValue(temp);
      Platform.isDesktopApp = true;
      const guard = await desktopGuard({ adapter } as unknown as Vault);
      await expect(guard("materials/link")).rejects.toThrow("Unsupported");
      await expect(guard("materials/new")).resolves.toBeUndefined();
    } finally {
      Platform.isDesktopApp = false;
      await rm(temp, { recursive: true, force: true });
    }
  });
});
