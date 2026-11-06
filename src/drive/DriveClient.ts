import { photoUrl } from "../auth/CredentialEncryption";
import type { AuthProvider } from "../auth/OAuthManager";
import { affected, basename, parent, relative, segment } from "../utils/paths";
import { fingerprint } from "../sync/ReconciliationEngine";
import type {
  ByteProgress,
  FileState,
  RemoteBackend,
  Snapshot,
} from "../sync/types";
import {
  header,
  json,
  ok,
  ServiceError,
  type Http,
  type HttpResponse,
} from "./Http";
const API = "https://www.googleapis.com/drive/v3";
const TRANSFER_CHUNK = 8 * 1024 * 1024;
export const FOLDER = "application/vnd.google-apps.folder";
const FIELDS =
  "id,name,mimeType,size,modifiedTime,sha256Checksum,md5Checksum,version,parents,trashed,ownedByMe,driveId,capabilities(canDownload,canEdit,canTrash,canAddChildren)";
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  sha256Checksum?: string;
  md5Checksum?: string;
  version?: string;
  parents?: string[];
  trashed?: boolean;
  ownedByMe?: boolean;
  driveId?: string;
  capabilities?: {
    canDownload?: boolean;
    canEdit?: boolean;
    canTrash?: boolean;
    canAddChildren?: boolean;
  };
}
interface Page {
  files: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}
export interface DriveAccount {
  id: string;
  email: string;
  photoUrl?: string;
  displayName?: string;
}
export class DriveClient implements RemoteBackend {
  accountInformation?: DriveAccount;
  private etags = new Map<string, string>();
  constructor(
    private http: Http,
    private auth: AuthProvider,
    public folderId: string,
    private accountId: string,
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
    absolute = false,
  ): Promise<HttpResponse> {
    const url = absolute ? path : `${API}${path}`;
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "www.googleapis.com"
    )
      throw new Error("Untrusted Drive endpoint");
    const r = await this.http({
      url,
      method,
      body,
      headers: {
        Authorization: `Bearer ${await this.auth.token()}`,
        ...headers,
      },
    });
    if (r.status === 401) {
      this.auth.lock();
      throw new ServiceError(401);
    }
    return r;
  }
  private async data<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const r = await this.request(
      path,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { "Content-Type": "application/json" },
    );
    ok(r);
    return json<T>(r);
  }
  async account(): Promise<DriveAccount> {
    const r = await this.data<{
      user?: {
        permissionId?: string;
        emailAddress?: string;
        photoLink?: string;
        displayName?: string;
      };
    }>("/about?fields=user(permissionId,emailAddress,displayName,photoLink)");
    if (!r.user?.permissionId || !r.user.emailAddress)
      throw new Error("Cannot verify Google account");
    if (this.accountId && this.accountId !== r.user.permissionId)
      throw new Error("Wrong Google account. No reconciliation performed.");
    this.accountInformation = {
      id: r.user.permissionId,
      email: r.user.emailAddress,
      ...(photoUrl(r.user.photoLink)
        ? { photoUrl: photoUrl(r.user.photoLink) }
        : {}),
      ...(typeof r.user.displayName === "string"
        ? { displayName: r.user.displayName }
        : {}),
    };
    return this.accountInformation;
  }
  async metadata(id: string): Promise<DriveFile> {
    if (!/^[\w-]+$/u.test(id)) throw new Error("Invalid Drive ID");
    const response = await this.request(
      `/files/${id}?fields=${encodeURIComponent(FIELDS)}`,
    );
    ok(response);
    const etag = header(response, "etag");
    if (etag) this.etags.set(id, etag);
    else this.etags.delete(id);
    const f = json<DriveFile>(response);
    if (
      !f ||
      typeof f.id !== "string" ||
      !/^[\w-]+$/u.test(f.id) ||
      (id !== "root" && f.id !== id) ||
      typeof f.name !== "string" ||
      typeof f.mimeType !== "string"
    )
      throw new Error("Invalid Drive metadata");
    return f;
  }
  async validateFolder(
    id = this.folderId,
  ): Promise<{ id: string; name: string }> {
    const f = await this.metadata(id);
    if (
      f.trashed ||
      f.mimeType !== FOLDER ||
      !f.ownedByMe ||
      f.driveId ||
      !f.capabilities?.canAddChildren
    )
      throw new Error(
        "Select an owned, writable My Drive folder. Shared-drive and shared-only trees are unsupported in v1.",
      );
    return { id: f.id, name: f.name };
  }
  async children(id: string, foldersOnly = false): Promise<DriveFile[]> {
    if (id === "root") id = (await this.metadata("root")).id;
    if (!/^[\w-]+$/u.test(id)) throw new Error("Invalid parent ID");
    const results: DriveFile[] = [],
      seen = new Set<string>();
    let token = "";
    do {
      const p = new URLSearchParams({
        q: `'${id}' in parents and trashed=false${foldersOnly ? ` and mimeType='${FOLDER}'` : ""}`,
        pageSize: "1000",
        fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
      });
      if (token) p.set("pageToken", token);
      const page = await this.data<Page>(`/files?${p}`);
      if (
        !page ||
        !Array.isArray(page.files) ||
        page.incompleteSearch ||
        (page.nextPageToken !== undefined &&
          (typeof page.nextPageToken !== "string" || !page.nextPageToken))
      )
        throw new Error("Incomplete or invalid Drive listing; scan stopped");
      for (const f of page.files) {
        if (
          !f ||
          typeof f.id !== "string" ||
          !/^[\w-]+$/u.test(f.id) ||
          typeof f.name !== "string" ||
          typeof f.mimeType !== "string" ||
          !Array.isArray(f.parents) ||
          !f.parents.includes(id) ||
          f.trashed
        )
          throw new Error("Invalid child identity in Drive listing");
        results.push(f);
      }
      token = page.nextPageToken ?? "";
      if (token && seen.has(token))
        throw new Error("Repeated pagination token; incomplete scan");
      if (token) seen.add(token);
    } while (token);
    return results;
  }
  async folders(id = "root"): Promise<{ id: string; name: string }[]> {
    return (await this.children(id, true))
      .filter((f) => f.ownedByMe && !f.driveId)
      .map((f) => ({ id: f.id, name: f.name }));
  }
  async createFolder(
    name: string,
    id = "root",
  ): Promise<{ id: string; name: string }> {
    segment(name);
    if (id !== "root") await this.validateFolder(id);
    if ((await this.children(id)).some((f) => f.name === name))
      throw new Error("Folder name already occupied");
    const next = await this.reserveId();
    const result = await this.data<DriveFile>(
      `/files?fields=${encodeURIComponent(FIELDS)}`,
      "POST",
      { id: next, name, mimeType: FOLDER, parents: [id] },
    );
    if (result.id !== next)
      throw new Error("Folder creation identity mismatch");
    return this.validateFolder(next);
  }
  private file(f: DriveFile, path: string, etag?: string): FileState {
    const size = Number(f.size),
      modifiedAt = Date.parse(f.modifiedTime ?? "");
    if (
      !f.ownedByMe ||
      f.driveId ||
      f.mimeType.startsWith("application/vnd.google-apps.") ||
      !f.capabilities?.canDownload ||
      !f.capabilities.canEdit ||
      !f.capabilities.canTrash
    )
      throw new Error(
        "Unsupported cloud object or insufficient file permissions",
      );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isFinite(modifiedAt) ||
      !f.version ||
      (!f.sha256Checksum && !f.md5Checksum)
    )
      throw new Error("Missing reliable binary metadata/checksum");
    if (
      (f.sha256Checksum && !/^[a-f0-9]{64}$/u.test(f.sha256Checksum)) ||
      (f.md5Checksum && !/^[a-f0-9]{32}$/u.test(f.md5Checksum))
    )
      throw new Error("Invalid Drive checksum");
    return {
      path,
      size,
      modifiedAt,
      hashes: {
        ...(f.sha256Checksum ? { sha256: f.sha256Checksum } : {}),
        ...(f.md5Checksum ? { md5: f.md5Checksum } : {}),
      },
      id: f.id,
      version: f.version,
      parents: f.parents,
      etag,
    };
  }
  async scan(): Promise<Snapshot> {
    await this.account();
    await this.validateFolder();
    const snapshot: Snapshot = {
      files: Object.create(null) as Record<string, FileState>,
      blocked: [],
      warnings: [],
      scannedAt: Date.now(),
      identity: `${this.accountId}:${this.folderId}`,
    };
    const queue = [{ id: this.folderId, path: "" }],
      seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current.id))
        throw new Error("Repeated Drive identity or folder cycle");
      seen.add(current.id);
      const children = await this.children(current.id),
        names = new Map<string, DriveFile[]>();
      for (const f of children) {
        try {
          segment(f.name);
        } catch {
          snapshot.blocked.push(current.path);
          snapshot.warnings.push(
            `Unsupported remote name inside ${current.path || "/"}`,
          );
          continue;
        }
        const key = f.name.normalize("NFC").toLowerCase();
        const group = names.get(key) ?? [];
        group.push(f);
        names.set(key, group);
      }
      for (const group of names.values()) {
        if (group.length > 1) {
          for (const f of group)
            snapshot.blocked.push(
              current.path ? `${current.path}/${f.name}` : f.name,
            );
          snapshot.warnings.push(
            "Duplicate or case-colliding remote paths blocked",
          );
          continue;
        }
        const f = group[0]!,
          p = current.path ? `${current.path}/${f.name}` : f.name;
        if (f.mimeType === FOLDER) {
          if (!f.ownedByMe || f.driveId || !f.capabilities?.canAddChildren) {
            snapshot.blocked.push(p);
            snapshot.warnings.push(`Unsupported remote folder: ${p}`);
          } else queue.push({ id: f.id, path: p });
        } else {
          if (seen.has(f.id)) throw new Error("Duplicate remote file identity");
          seen.add(f.id);
          try {
            snapshot.files[p] = this.file(f, p);
          } catch {
            snapshot.blocked.push(p);
            snapshot.warnings.push(`Unsupported remote file or checksum: ${p}`);
          }
        }
      }
    }
    return snapshot;
  }
  async read(file: FileState, onProgress?: ByteProgress): Promise<ArrayBuffer> {
    if (!file.id) throw new Error("Missing remote identity");
    const endpoint = `/files/${file.id}?alt=media`;
    onProgress?.(0, file.size);
    if (!onProgress || file.size <= TRANSFER_CHUNK) {
      const response = await this.request(endpoint);
      ok(response);
      if (onProgress && response.data.byteLength !== file.size)
        throw new Error("Needs Rescan: downloaded size differs from preview");
      onProgress?.(response.data.byteLength, file.size);
      return response.data;
    }
    // Range requests provide actual received-byte progress through requestUrl,
    // whose public API has no streaming/download progress callback.
    let result: Uint8Array<ArrayBuffer> | undefined;
    for (let offset = 0; offset < file.size;) {
      const end = Math.min(offset + TRANSFER_CHUNK, file.size);
      const response = await this.request(endpoint, "GET", undefined, {
        Range: `bytes=${offset}-${end - 1}`,
        ...(file.etag ? { "If-Match": file.etag } : {}),
      });
      ok(response);
      // A server may ignore Range and send the whole file on the first request.
      if (
        response.status === 200 &&
        offset === 0 &&
        response.data.byteLength === file.size
      ) {
        onProgress(file.size, file.size);
        return response.data;
      }
      const range = header(response, "content-range")?.match(
        /^bytes (\d+)-(\d+)\/(\d+)$/u,
      );
      if (
        response.status !== 206 ||
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) !== end - 1 ||
        Number(range[3]) !== file.size ||
        response.data.byteLength !== end - offset
      )
        throw new Error("Needs Rescan: invalid or changed download range");
      result ??= new Uint8Array(file.size);
      result.set(new Uint8Array(response.data), offset);
      offset = end;
      onProgress(offset, file.size);
    }
    return result!.buffer;
  }
  async reserveId(): Promise<string> {
    const r = await this.data<{ ids?: string[] }>(
      "/files/generateIds?count=1&space=drive&type=files",
    );
    const id = r.ids?.[0];
    if (!id || !/^[\w-]+$/u.test(id))
      throw new Error("Could not reserve remote file ID");
    return id;
  }
  private async check(file: FileState): Promise<DriveFile> {
    const f = await this.metadata(file.id!);
    if (
      f.trashed ||
      f.name !== basename(file.path) ||
      fingerprint(this.file(f, file.path)) !== fingerprint(file)
    )
      throw new Error("Needs Rescan: remote file changed");
    return f;
  }
  private async ensureParent(path: string): Promise<string> {
    let id = this.folderId;
    for (const part of parent(path).split("/").filter(Boolean)) {
      await this.validateFolder(id);
      const matches = (await this.children(id)).filter(
        (f) =>
          f.name.normalize("NFC").toLowerCase() ===
          part.normalize("NFC").toLowerCase(),
      );
      if (
        matches.length > 1 ||
        matches.some((f) => f.name !== part || f.mimeType !== FOLDER)
      )
        throw new Error("Remote destination collision");
      id = matches[0]?.id ?? (await this.createFolder(part, id)).id;
    }
    await this.validateFolder(id);
    return id;
  }
  private async destination(path: string, exceptId?: string): Promise<string> {
    const p = await this.ensureParent(path),
      name = basename(path);
    if (
      (await this.children(p)).some(
        (f) =>
          f.id !== exceptId &&
          f.name.normalize("NFC").toLowerCase() ===
            name.normalize("NFC").toLowerCase(),
      )
    )
      throw new Error("Needs Rescan: destination already occupied");
    return p;
  }
  async upload(
    path: string,
    data: ArrayBuffer,
    expected: FileState | null,
    newId?: string,
    onProgress?: ByteProgress,
  ): Promise<void> {
    relative(path);
    onProgress?.(0, data.byteLength);
    const parentId = await this.destination(path, expected?.id);
    if (expected) await this.check(expected);
    if (!expected && !newId)
      throw new Error("New upload requires a journaled reserved ID");
    const metadata = expected
      ? {}
      : {
          id: newId,
          name: basename(path),
          parents: [parentId],
          mimeType: "application/octet-stream",
        };
    const endpoint = `https://www.googleapis.com/upload/drive/v3/files${expected ? `/${expected.id}` : ""}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`;
    const start = await this.request(
      endpoint,
      expected ? "PATCH" : "POST",
      JSON.stringify(metadata),
      {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(data.byteLength),
        ...(expected?.id && this.etags.get(expected.id)
          ? { "If-Match": this.etags.get(expected.id)! }
          : {}),
      },
      true,
    );
    ok(start);
    const session = header(start, "location");
    if (!session) throw new Error("Missing resumable upload session");
    const chunk = TRANSFER_CHUNK;
    if (data.byteLength === 0) {
      const r = await this.request(
        session,
        "PUT",
        data,
        { "Content-Type": "application/octet-stream" },
        true,
      );
      ok(r);
      onProgress?.(0, 0);
      return;
    }
    for (let offset = 0; offset < data.byteLength;) {
      const end = Math.min(offset + chunk, data.byteLength);
      const r = await this.request(
        session,
        "PUT",
        data.slice(offset, end),
        {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${offset}-${end - 1}/${data.byteLength}`,
        },
        true,
      );
      if (r.status === 308) {
        const range = header(r, "range"),
          match = range?.match(/^bytes=0-(\d+)$/u),
          next = match ? Number(match[1]) + 1 : 0;
        if (next <= offset || next > end)
          throw new Error(
            "Uncertain resumable upload progress. Rescan before retrying.",
          );
        offset = next;
      } else {
        ok(r);
        if (end !== data.byteLength)
          throw new Error("Upload completed before expected byte count");
        offset = end;
      }
      onProgress?.(offset, data.byteLength);
    }
  }
  async rename(file: FileState, target: string): Promise<void> {
    relative(target);
    const parentId = await this.destination(target, file.id);
    const current = await this.check(file);
    const q = new URLSearchParams({ fields: FIELDS });
    if (!current.parents?.includes(parentId)) {
      q.set("addParents", parentId);
      q.set("removeParents", (current.parents ?? []).join(","));
    }
    const r = await this.request(
      `/files/${file.id}?${q}`,
      "PATCH",
      JSON.stringify({ name: basename(target) }),
      {
        "Content-Type": "application/json",
        ...(this.etags.get(file.id!)
          ? { "If-Match": this.etags.get(file.id!)! }
          : {}),
      },
    );
    ok(r);
  }
  async trash(file: FileState): Promise<void> {
    // Ensure file still belongs to the configured tree before mutation.
    const current = await this.scan();
    if (
      affected(file.path, current.blocked) ||
      fingerprint(current.files[file.path]) !== fingerprint(file)
    )
      throw new Error("Needs Rescan: remote identity changed");
    await this.check(file);
    const r = await this.request(
      `/files/${file.id}`,
      "PATCH",
      JSON.stringify({ trashed: true }),
      {
        "Content-Type": "application/json",
        ...(this.etags.get(file.id!)
          ? { "If-Match": this.etags.get(file.id!)! }
          : {}),
      },
    );
    ok(r);
    if (!(await this.metadata(file.id!)).trashed)
      throw new Error("Remote trash verification failed");
  }
}
