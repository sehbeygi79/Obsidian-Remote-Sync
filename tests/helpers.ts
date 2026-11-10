import { hashes } from "../src/utils/hashing";
import { equal, fingerprint } from "../src/sync/ReconciliationEngine";
import type {
  Baseline,
  FileState,
  LocalBackend,
  RemoteBackend,
  Snapshot,
} from "../src/sync/types";
import { SyncStateStore } from "../src/sync/SyncStateStore";
import { affected } from "../src/utils/paths";
export const bytes = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer;
export function file(
  path = "a.pdf",
  content = "original",
  remote = false,
  time = 1000,
): FileState {
  return {
    path,
    size: bytes(content).byteLength,
    modifiedAt: time,
    hashes: hashes(bytes(content)),
    ...(remote ? { id: `id-${path}`, version: "1", parents: ["folder"] } : {}),
  };
}
export function snapshot(files: FileState[] = [], identity = "test"): Snapshot {
  return {
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    blocked: [],
    warnings: [],
    scannedAt: Date.now(),
    identity,
  };
}
export function baseline(path = "a.pdf", content = "original"): Baseline {
  const l = file(path, content),
    r = file(path, content, true);
  return {
    key: path,
    path,
    hash: l.hashes,
    size: l.size,
    remoteId: r.id,
    syncedAt: 1000,
    local: l,
    remote: r,
  };
}
export function memoryStore(): SyncStateStore {
  const data = new Map<string, string>();
  return new SyncStateStore(
    {
      read: async (p) => {
        if (!data.has(p)) throw new Error("Missing");
        return data.get(p)!;
      },
      write: async (p, v) => {
        data.set(p, v);
      },
      exists: async (p) => data.has(p),
    },
    "state",
  );
}
export class Backend implements LocalBackend, RemoteBackend {
  files: Record<string, FileState> = {};
  contents: Record<string, ArrayBuffer> = {};
  calls: string[] = [];
  identity = "test";
  blocked: string[] = [];
  beforeScan: (() => void) | null = null;
  fail = "";
  next = 1;
  constructor(
    files: Record<string, string> = {},
    private remote = false,
  ) {
    for (const [p, c] of Object.entries(files)) this.put(p, c);
  }
  put(p: string, c: string): void {
    this.files[p] = file(p, c, this.remote, 1000 + this.next++);
    this.contents[p] = bytes(c);
  }
  async scan(
    targets?: readonly string[],
    _options?: { includeMd5?: boolean },
  ): Promise<Snapshot> {
    this.beforeScan?.();
    if (this.fail === "scan") throw new Error("Network failed");
    const s = snapshot(
      structuredClone(
        Object.values(this.files).filter(
          (file) => !targets || affected(file.path, targets),
        ),
      ),
      this.identity,
    );
    s.blocked = [...this.blocked];
    return s;
  }
  async read(p: string | FileState): Promise<ArrayBuffer> {
    const path = typeof p === "string" ? p : p.path;
    this.calls.push(`read:${path}`);
    if (!this.contents[path]) throw new Error("missing");
    return this.contents[path]!.slice(0);
  }
  async reserveId(): Promise<string> {
    return `reserved-${this.next++}`;
  }
  async write(
    p: string,
    data: ArrayBuffer,
    expected: FileState | null,
  ): Promise<void> {
    if (fingerprint(expected) !== fingerprint(this.files[p]))
      throw new Error("Needs Rescan");
    if (this.fail === "write") throw new Error("write failed");
    this.calls.push(`write:${p}`);
    this.files[p] = {
      path: p,
      size: data.byteLength,
      hashes: hashes(data),
      modifiedAt: 2000 + this.next++,
    };
    this.contents[p] = data;
  }
  async upload(
    p: string,
    data: ArrayBuffer,
    expected: FileState | null,
    id?: string,
  ): Promise<void> {
    if (fingerprint(expected) !== fingerprint(this.files[p]))
      throw new Error("Needs Rescan");
    this.calls.push(`upload:${p}`);
    if (this.fail === "upload") throw new Error("network failed");
    this.files[p] = {
      path: p,
      size: data.byteLength,
      hashes: hashes(data),
      modifiedAt: 2000 + this.next++,
      id: expected?.id ?? id,
      version: String(this.next),
      parents: ["folder"],
    };
    this.contents[p] = data;
    if (this.fail === "verify")
      this.files[p]!.hashes = hashes(bytes("damaged"));
  }
  async rename(
    source: string | FileState,
    target: string,
    expected?: FileState,
  ): Promise<void> {
    const f = typeof source === "string" ? expected! : source;
    if (
      fingerprint(this.files[f.path]) !== fingerprint(f) ||
      this.files[target]
    )
      throw new Error("Needs Rescan");
    this.calls.push(`rename:${f.path}:${target}`);
    this.files[target] = {
      ...f,
      path: target,
      version: f.version ? String(Number(f.version) + 1) : undefined,
    };
    this.contents[target] = this.contents[f.path]!;
    delete this.files[f.path];
    delete this.contents[f.path];
  }
  async trash(source: string | FileState, expected?: FileState): Promise<void> {
    const f = typeof source === "string" ? expected! : source;
    if (!equal(this.files[f.path], f)) throw new Error("Needs Rescan");
    this.calls.push(`trash:${f.path}`);
    delete this.files[f.path];
    delete this.contents[f.path];
  }
}
