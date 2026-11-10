import { describe, it, expect, vi } from "vitest";
import { DriveClient, FOLDER } from "../src/drive/DriveClient";
import { bytes, file } from "./helpers";
import type { Http, HttpRequest, HttpResponse } from "../src/drive/Http";
const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers,
  text: JSON.stringify(value),
  data: bytes("original"),
});
function driveFile(name = "a.pdf", id = "id-a") {
  const f = file(name, "original", true);
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    size: String(f.size),
    modifiedTime: new Date(f.modifiedAt).toISOString(),
    sha256Checksum: f.hashes.sha256,
    md5Checksum: f.hashes.md5,
    version: "1",
    parents: ["folder"],
    ownedByMe: true,
    capabilities: { canDownload: true, canEdit: true, canTrash: true },
  };
}
function mock(
  extra?: (req: HttpRequest) => HttpResponse | undefined,
  isIgnored?: (path: string) => boolean,
) {
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => {
    requests.push(req);
    const custom = extra?.(req);
    if (custom) return custom;
    const u = new URL(req.url);
    if (u.pathname.endsWith("/about"))
      return response({
        user: { permissionId: "account", emailAddress: "user@example.test" },
      });
    if (u.pathname.endsWith("/generateIds"))
      return response({ ids: ["reserved"] });
    if (u.pathname.endsWith("/files/folder"))
      return response({
        id: "folder",
        name: "Materials",
        mimeType: FOLDER,
        ownedByMe: true,
        capabilities: { canAddChildren: true },
      });
    if (u.pathname.endsWith("/files/id-a")) return response(driveFile());
    if (u.pathname.endsWith("/files"))
      return response({ files: [driveFile()] });
    throw new Error("Unexpected request");
  };
  const auth = { token: vi.fn(async () => "access-secret"), lock: vi.fn() };
  return {
    drive: new DriveClient(http, auth, "folder", "account", isIgnored),
    requests,
    auth,
  };
}
describe("Drive scanner fails closed", () => {
  it("does not enter ignored folders or report ignored unsupported/duplicate files as blocked", async () => {
    const { drive, requests } = mock(
      (req) => {
        if (new URL(req.url).pathname.endsWith("/files"))
          return response({
            files: [
              driveFile(),
              { ...driveFile("private", "folder-private"), mimeType: FOLDER },
              {
                ...driveFile("hidden.gdoc", "doc"),
                mimeType: "application/vnd.google-apps.document",
              },
              driveFile("hidden.gdoc", "duplicate"),
            ],
          });
      },
      (path) =>
        path === "private" ||
        path.startsWith("private/") ||
        path === "hidden.gdoc",
    );
    const scan = await drive.scan();
    expect(Object.keys(scan.files)).toEqual(["a.pdf"]);
    expect(scan.blocked).toEqual([]);
    expect(scan.warnings).toEqual([]);
    expect(
      requests.filter((req) => new URL(req.url).pathname.endsWith("/files")),
    ).toHaveLength(1);
    const before = requests.length;
    await expect(
      drive.read(file("private/a.pdf", "original", true)),
    ).rejects.toThrow("ignored");
    await expect(
      drive.upload("private/new.pdf", bytes("new"), null),
    ).rejects.toThrow("ignored");
    await expect(
      drive.rename(scan.files["a.pdf"]!, "private/a.pdf"),
    ).rejects.toThrow("ignored");
    await expect(
      drive.trash(file("private/a.pdf", "original", true)),
    ).rejects.toThrow("ignored");
    expect(requests).toHaveLength(before);
  });
  it("resolves the root alias before validating child parents", async () => {
    const { drive } = mock((req) => {
      if (req.url.includes("/files/root?"))
        return response({
          id: "actual-root",
          name: "My Drive",
          mimeType: FOLDER,
        });
      if (req.url.includes("/files?"))
        return response({
          files: [
            {
              ...driveFile("child", "child-id"),
              mimeType: FOLDER,
              parents: ["actual-root"],
            },
          ],
        });
    });
    expect(await drive.folders()).toEqual([{ id: "child-id", name: "child" }]);
  });
  it("reads compatible binary metadata", async () => {
    const { drive } = mock();
    const s = await drive.scan();
    expect(s.files["a.pdf"]!.id).toBe("id-a");
    expect(s.files["a.pdf"]!.hashes.sha256).toBeDefined();
  });
  it("paginates all pages before returning", async () => {
    const { drive, requests } = mock((req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/files"))
        return response(
          u.searchParams.get("pageToken")
            ? { files: [driveFile("b.pdf", "id-b")] }
            : { files: [driveFile()], nextPageToken: "next" },
        );
    });
    const s = await drive.scan();
    expect(Object.keys(s.files)).toEqual(["a.pdf", "b.pdf"]);
    expect(requests.some((r) => r.url.includes("pageToken=next"))).toBe(true);
  });
  it("second-page failure is not an empty listing", async () => {
    const { drive } = mock((req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/files"))
        return u.searchParams.get("pageToken")
          ? response({}, 503)
          : response({ files: [driveFile()], nextPageToken: "next" });
    });
    await expect(drive.scan()).rejects.toThrow("503");
  });
  it.each([401, 403, 404, 429, 500])(
    "HTTP %s cannot imply absence",
    async (status) => {
      const { drive } = mock((req) =>
        req.url.includes("/files?") ? response({}, status) : undefined,
      );
      await expect(drive.scan()).rejects.toThrow();
    },
  );
  it("rejects incompleteSearch", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [], incompleteSearch: true })
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("Incomplete");
  });
  it("rejects malformed listing", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?") ? response({}) : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("listing");
  });
  it("rejects repeated pagination tokens", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [], nextPageToken: "repeat" })
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("Repeated");
  });
  it("duplicate Drive names block affected path", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [driveFile(), driveFile("a.pdf", "second")] })
        : undefined,
    );
    const s = await drive.scan();
    expect(s.files["a.pdf"]).toBeUndefined();
    expect(s.blocked).toContain("a.pdf");
  });
  it("case duplicate Drive names also block paths", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [driveFile(), driveFile("A.pdf", "second")] })
        : undefined,
    );
    expect((await drive.scan()).blocked).toHaveLength(2);
  });
  it("unsupported native documents are reported", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({
            files: [
              {
                ...driveFile(),
                mimeType: "application/vnd.google-apps.document",
              },
            ],
          })
        : undefined,
    );
    expect((await drive.scan()).blocked).toContain("a.pdf");
  });
  it("missing checksums block a file without downloading it", async () => {
    const f = {
      ...driveFile(),
      sha256Checksum: undefined,
      md5Checksum: undefined,
    };
    const { drive, requests } = mock((req) =>
      req.url.includes("/files?") ? response({ files: [f] }) : undefined,
    );
    expect((await drive.scan()).blocked).toContain("a.pdf");
    expect(requests.some((r) => r.url.includes("alt=media"))).toBe(false);
  });
  it("remote traversal filename blocks its parent", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [driveFile("../outside")] })
        : undefined,
    );
    expect((await drive.scan()).blocked).toContain("");
  });
  it("wrong account blocks scan", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/about?")
        ? response({
            user: { permissionId: "wrong", emailAddress: "other@test" },
          })
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("Wrong Google account");
  });
  it("missing root blocks scan", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files/folder?") ? response({}, 404) : undefined,
    );
    await expect(drive.scan()).rejects.toThrow();
  });
  it("nonowned or shared root is refused", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files/folder?")
        ? response({
            id: "folder",
            name: "Shared",
            mimeType: FOLDER,
            ownedByMe: false,
          })
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("owned");
  });
  it("invalid child parent identity is rejected", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ files: [{ ...driveFile(), parents: ["outside"] }] })
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("identity");
  });
});
describe("Drive mutations", () => {
  it("reports only bytes acknowledged by the upload server", async () => {
    let chunks = 0;
    const total = 9 * 1024 * 1024;
    const progress = vi.fn();
    const { drive } = mock((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/upload/drive/v3/files")
        return response({}, 200, {
          location: "https://www.googleapis.com/upload-session",
        });
      if (path === "/upload-session")
        return ++chunks === 1
          ? response({}, 308, { range: "bytes=0-4194303" })
          : response({});
      if (path.endsWith("/files")) return response({ files: [] });
    });
    await drive.upload(
      "large.bin",
      new ArrayBuffer(total),
      null,
      "reserved",
      progress,
    );
    expect(progress.mock.calls).toEqual([
      [0, total],
      [4 * 1024 * 1024, total],
      [total, total],
    ]);
  });

  it("does not report a failed upload chunk as transferred", async () => {
    let chunks = 0;
    const total = 9 * 1024 * 1024;
    const progress = vi.fn();
    const { drive } = mock((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/upload/drive/v3/files")
        return response({}, 200, {
          location: "https://www.googleapis.com/upload-session",
        });
      if (path === "/upload-session")
        return ++chunks === 1
          ? response({}, 308, { range: "bytes=0-8388607" })
          : response({}, 503);
      if (path.endsWith("/files")) return response({ files: [] });
    });
    await expect(
      drive.upload(
        "large.bin",
        new ArrayBuffer(total),
        null,
        "reserved",
        progress,
      ),
    ).rejects.toThrow();
    expect(progress.mock.calls).toEqual([
      [0, total],
      [8 * 1024 * 1024, total],
    ]);
  });
  it("resumable create uses journaled ID and binary MIME without conversion", async () => {
    const { drive, requests } = mock((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/upload/drive/v3/files")
        return response({}, 200, {
          location: "https://www.googleapis.com/upload-session",
        });
      if (u.pathname === "/upload-session")
        return response(driveFile("new", "reserved"));
      if (u.pathname.endsWith("/files")) return response({ files: [] });
    });
    await drive.upload("new", bytes("original"), null, "reserved");
    const start = requests.find((r) => r.url.includes("uploadType=resumable"))!;
    expect(JSON.parse(start.body as string)).toMatchObject({
      id: "reserved",
      mimeType: "application/octet-stream",
      parents: ["folder"],
    });
    expect(requests.at(-1)!.headers!["Content-Range"]).toBe("bytes 0-7/8");
  });
  it("uploads chunks after 308 acknowledged ranges", async () => {
    let chunks = 0;
    const { drive } = mock((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/upload/drive/v3/files")
        return response({}, 200, {
          location: "https://www.googleapis.com/upload-session",
        });
      if (u.pathname === "/upload-session")
        return ++chunks === 1
          ? response({}, 308, { range: "bytes=0-8388607" })
          : response(driveFile("new", "reserved"));
      if (u.pathname.endsWith("/files")) return response({ files: [] });
    });
    await drive.upload(
      "new",
      new ArrayBuffer(9 * 1024 * 1024),
      null,
      "reserved",
    );
    expect(chunks).toBe(2);
  });
  it("network interruption is not retried as another create", async () => {
    let creates = 0;
    const { drive } = mock((req) => {
      if (req.url.includes("/upload/drive/v3/")) {
        creates++;
        return response({}, 503);
      }
      if (req.url.includes("/files?")) return response({ files: [] });
    });
    await expect(
      drive.upload("new", bytes("original"), null, "reserved"),
    ).rejects.toThrow();
    expect(creates).toBe(1);
  });
  it("refuses malicious resumable endpoint", async () => {
    const { drive } = mock((req) => {
      if (req.url.includes("/upload/drive/v3/"))
        return response({}, 200, { location: "https://evil.example/upload" });
      if (req.url.includes("/files?")) return response({ files: [] });
    });
    await expect(
      drive.upload("new", bytes("original"), null, "reserved"),
    ).rejects.toThrow("Untrusted");
  });
  it("rejects unknown create IDs", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?") ? response({ files: [] }) : undefined,
    );
    await expect(drive.upload("new", bytes("x"), null)).rejects.toThrow(
      "journaled",
    );
  });
  it("does not silently overwrite an occupied destination", async () => {
    const { drive } = mock();
    await expect(
      drive.upload("a.pdf", bytes("x"), null, "reserved"),
    ).rejects.toThrow("occupied");
  });
  it("rate limiting surfaces an actionable sanitized error", async () => {
    const { drive } = mock((req) =>
      req.url.includes("/files?")
        ? response({ error: "access-secret" }, 429)
        : undefined,
    );
    await expect(drive.scan()).rejects.toThrow("rate limit");
    await expect(drive.scan()).rejects.not.toThrow("access-secret");
  });
});
describe("download byte progress", () => {
  const chunk = 8 * 1024 * 1024,
    total = 9 * 1024 * 1024;
  const remote = () => ({ ...file(), id: "id-a", size: total });

  it("assembles validated ranges and reports received bytes", async () => {
    const progress = vi.fn();
    const { drive, requests } = mock((req) => {
      if (!req.url.includes("alt=media")) return;
      const first = req.headers?.Range === `bytes=0-${chunk - 1}`;
      return {
        ...response({}, 206, {
          "Content-Range": `bytes ${first ? 0 : chunk}-${first ? chunk - 1 : total - 1}/${total}`,
        }),
        data: new Uint8Array(first ? chunk : total - chunk).fill(first ? 7 : 9)
          .buffer,
      };
    });
    const data = new Uint8Array(await drive.read(remote(), progress));
    expect(data.byteLength).toBe(total);
    expect([data[0], data[chunk - 1], data[chunk], data[total - 1]]).toEqual([
      7, 7, 9, 9,
    ]);
    expect(requests.map((req) => req.headers?.Range)).toEqual([
      `bytes=0-${chunk - 1}`,
      `bytes=${chunk}-${total - 1}`,
    ]);
    expect(progress.mock.calls).toEqual([
      [0, total],
      [chunk, total],
      [total, total],
    ]);
  });

  it.each(["range", "length", "total"])(
    "rejects mismatched download %s before reporting that chunk",
    async (problem) => {
      const progress = vi.fn();
      const { drive } = mock((req) =>
        req.url.includes("alt=media")
          ? {
              ...response({}, 206, {
                "content-range": `bytes ${problem === "range" ? 1 : 0}-${chunk - 1}/${problem === "total" ? total + 1 : total}`,
              }),
              data: new ArrayBuffer(problem === "length" ? chunk - 1 : chunk),
            }
          : undefined,
      );
      await expect(drive.read(remote(), progress)).rejects.toThrow(
        "Needs Rescan",
      );
      expect(progress.mock.calls).toEqual([[0, total]]);
    },
  );

  it("leaves progress incomplete when a later download range fails", async () => {
    const progress = vi.fn();
    let ranges = 0;
    const { drive } = mock((req) => {
      if (!req.url.includes("alt=media")) return;
      return ++ranges === 1
        ? {
            ...response({}, 206, {
              "content-range": `bytes 0-${chunk - 1}/${total}`,
            }),
            data: new ArrayBuffer(chunk),
          }
        : response({}, 503);
    });
    await expect(drive.read(remote(), progress)).rejects.toThrow();
    expect(progress.mock.calls).toEqual([
      [0, total],
      [chunk, total],
    ]);
  });

  it("accepts a complete response when the first range is ignored", async () => {
    const progress = vi.fn();
    const { drive, requests } = mock((req) =>
      req.url.includes("alt=media")
        ? { ...response({}), data: new ArrayBuffer(total) }
        : undefined,
    );
    expect((await drive.read(remote(), progress)).byteLength).toBe(total);
    expect(requests).toHaveLength(1);
    expect(progress.mock.calls).toEqual([
      [0, total],
      [total, total],
    ]);
  });
});
describe("Drive identity-preserving operations", () => {
  it("renames with PATCH and preserves ID, passing a returned ETag", async () => {
    const { drive, requests } = mock((req) =>
      req.url.includes("/files/id-a?")
        ? response(driveFile(), 200, { etag: '"reviewed"' })
        : undefined,
    );
    const expected = { ...file("a.pdf", "original", true), id: "id-a" };
    await drive.rename(expected, "new.pdf");
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.url).toContain("/files/id-a?");
    expect(JSON.parse(patch.body as string)).toEqual({ name: "new.pdf" });
    expect(patch.headers!["If-Match"]).toBe('"reviewed"');
  });
  it("moves into the correct nested folder without uploading contents", async () => {
    const { drive, requests } = mock((req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/files/sub"))
        return response({
          id: "sub",
          name: "nested",
          mimeType: FOLDER,
          ownedByMe: true,
          capabilities: { canAddChildren: true },
        });
      if (
        u.pathname.endsWith("/files") &&
        u.searchParams.get("q")?.includes("'sub'")
      )
        return response({ files: [] });
      if (u.pathname.endsWith("/files"))
        return response({
          files: [
            driveFile(),
            {
              id: "sub",
              name: "nested",
              mimeType: FOLDER,
              parents: ["folder"],
              ownedByMe: true,
              capabilities: { canAddChildren: true },
            },
          ],
        });
    });
    await drive.rename(
      { ...file("a.pdf", "original", true), id: "id-a" },
      "nested/new.pdf",
    );
    const patch = requests.find((r) => r.method === "PATCH")!;
    const q = new URL(patch.url).searchParams;
    expect(q.get("addParents")).toBe("sub");
    expect(q.get("removeParents")).toBe("folder");
    expect(requests.some((r) => r.url.includes("/upload/"))).toBe(false);
  });
  it("version changes invalidate remote mutation", async () => {
    const { drive, requests } = mock((req) =>
      req.url.includes("/files/id-a?")
        ? response({ ...driveFile(), version: "2" })
        : undefined,
    );
    await expect(
      drive.rename(
        { ...file("a.pdf", "original", true), id: "id-a" },
        "new.pdf",
      ),
    ).rejects.toThrow("Needs Rescan");
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("HTTP precondition failure is surfaced as Needs Rescan", async () => {
    const { drive } = mock((req) =>
      req.method === "PATCH" ? response({}, 412) : undefined,
    );
    await expect(
      drive.rename(
        { ...file("a.pdf", "original", true), id: "id-a" },
        "new.pdf",
      ),
    ).rejects.toThrow("Needs Rescan");
  });
  it("trashes with PATCH, verifies trashed state and never sends DELETE", async () => {
    let trashed = false;
    const { drive, requests } = mock((req) => {
      if (req.method === "PATCH") {
        trashed = true;
        return response({ id: "id-a", trashed: true });
      }
      if (req.url.includes("/files/id-a?"))
        return response({ ...driveFile(), trashed });
    });
    await drive.trash({ ...file("a.pdf", "original", true), id: "id-a" });
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(
      JSON.parse(requests.find((r) => r.method === "PATCH")!.body as string),
    ).toEqual({ trashed: true });
  });
});

it("creates shared Drive parents once while allowing sibling uploads to overlap", async () => {
  let created = false,
    creates = 0,
    sessions = 0;
  const pending: (() => void)[] = [];
  const folder = {
    id: "nested",
    name: "shared",
    mimeType: FOLDER,
    ownedByMe: true,
    parents: ["folder"],
    capabilities: { canAddChildren: true },
  };
  const http: Http = async (req) => {
    const url = new URL(req.url);
    if (req.method === "PUT") {
      await new Promise<void>((resolve) => pending.push(resolve));
      return response({});
    }
    if (url.pathname.startsWith("/upload/")) {
      sessions++;
      return response({}, 200, {
        location: `https://www.googleapis.com/session/${sessions}`,
      });
    }
    if (url.pathname.endsWith("/generateIds"))
      return response({ ids: ["nested"] });
    if (url.pathname.endsWith("/files/folder"))
      return response({ ...folder, id: "folder", name: "Root" });
    if (url.pathname.endsWith("/files/nested")) return response(folder);
    if (url.pathname.endsWith("/files") && req.method === "POST") {
      if (created) throw new Error("Duplicate folder creation");
      creates++;
      created = true;
      return response(folder);
    }
    if (url.pathname.endsWith("/files")) {
      const root = url.searchParams.get("q")!.includes("'folder'");
      return response({ files: root && created ? [folder] : [] });
    }
    throw new Error("Unexpected request");
  };
  const drive = new DriveClient(
    http,
    { token: async () => "token", lock: () => {} },
    "folder",
    "account",
  );
  const task = Promise.all([
    drive.upload("shared/a.pdf", bytes("a"), null, "a"),
    drive.upload("shared/b.pdf", bytes("b"), null, "b"),
  ]);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(creates).toBe(1);
  pending.forEach((resolve) => resolve());
  await task;
});

it("scoped Drive checks list only affected ancestors while full scans still traverse the whole tree", async () => {
  const folder = (id: string, name: string, parent = "folder") => ({
    id,
    name,
    mimeType: FOLDER,
    ownedByMe: true,
    parents: [parent],
    capabilities: { canAddChildren: true },
  });
  const { drive, requests } = mock((req) => {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/files")) return;
    const query = url.searchParams.get("q")!;
    if (query.includes("'folder'"))
      return response({
        files: [
          folder("selected", "selected"),
          folder("unrelated", "unrelated"),
          driveFile("large.mkv", "large"),
        ],
      });
    if (query.includes("'selected'"))
      return response({
        files: [
          { ...driveFile("small.md", "small"), parents: ["selected"] },
          { ...driveFile("other.mkv", "other"), parents: ["selected"] },
        ],
      });
    if (query.includes("'unrelated'"))
      throw new Error("Unrelated folder should not be listed");
  });
  const result = await drive.scan(["selected/small.md"]);
  expect(Object.keys(result.files)).toEqual(["selected/small.md"]);
  expect(result.identity).toBe("account:folder");
  expect(
    requests.filter((req) => new URL(req.url).pathname.endsWith("/files")),
  ).toHaveLength(2);
  expect(requests.some((req) => req.url.includes("alt=media"))).toBe(false);
  await expect(drive.scan()).rejects.toThrow("Unrelated folder");
});

it.each([false, true])(
  "scoped Drive checks retain collisions on selected files/ancestors (ancestor=%s)",
  async (ancestor) => {
    const { drive } = mock((req) => {
      if (!new URL(req.url).pathname.endsWith("/files")) return;
      const files = [driveFile("target", "one"), driveFile("TARGET", "two")];
      return response({
        files: ancestor
          ? files.map((file) => ({
              ...file,
              mimeType: FOLDER,
              capabilities: { canAddChildren: true },
            }))
          : files,
      });
    });
    const result = await drive.scan([ancestor ? "target/a.md" : "target"]);
    expect(result.files).toEqual({});
    expect(result.blocked).toEqual(["target", "TARGET"]);
  },
);

it("scoped Drive checks block inaccessible ancestors and never treat incomplete listings as absence", async () => {
  let incomplete = false;
  const { drive } = mock((req) => {
    if (!new URL(req.url).pathname.endsWith("/files")) return;
    return response({
      files: [
        {
          ...driveFile("selected", "selected"),
          mimeType: FOLDER,
          ownedByMe: false,
        },
      ],
      ...(incomplete ? { incompleteSearch: true } : {}),
    });
  });
  const result = await drive.scan(["selected/a.md"]);
  expect(result.blocked).toContain("selected");
  expect(result.files).toEqual({});
  incomplete = true;
  await expect(drive.scan(["selected/a.md"])).rejects.toThrow("Incomplete");
});

it("starts account, root validation and folder listings in parallel", async () => {
  const started: string[] = [],
    pending: (() => void)[] = [];
  const root = {
    id: "folder",
    name: "Root",
    mimeType: FOLDER,
    ownedByMe: true,
    capabilities: { canAddChildren: true },
  };
  const drive = new DriveClient(
    async (req) => {
      const path = new URL(req.url).pathname;
      started.push(path);
      await new Promise<void>((resolve) => pending.push(resolve));
      return path.endsWith("/about")
        ? response({
            user: { permissionId: "account", emailAddress: "a@test" },
          })
        : path.endsWith("/files/folder")
          ? response(root)
          : response({ files: [] });
    },
    { token: async () => "token", lock: () => {} },
    "folder",
    "account",
  );
  const task = drive.scan(["a.md"]);
  await vi.waitFor(() => expect(started).toHaveLength(3));
  pending.forEach((release) => release());
  expect((await task).files).toEqual({});
});

it("verifies the account once per Apply while retaining fresh root and path checks", async () => {
  const { drive, requests } = mock();
  drive.beginApply();
  await drive.scan(["a.pdf"]);
  await drive.scan(["a.pdf"]);
  await drive.scan(["a.pdf"]);
  expect(
    requests.filter((req) => new URL(req.url).pathname.endsWith("/about")),
  ).toHaveLength(1);
  expect(
    requests.filter((req) =>
      new URL(req.url).pathname.endsWith("/files/folder"),
    ),
  ).toHaveLength(3);
  expect(
    requests.filter((req) => new URL(req.url).pathname.endsWith("/files")),
  ).toHaveLength(3);
  drive.endApply();
  await drive.scan(["a.pdf"]);
  expect(
    requests.filter((req) => new URL(req.url).pathname.endsWith("/about")),
  ).toHaveLength(2);
});

it("coalesces sibling checks before dispatch while keeping later versions fresh", async () => {
  let version = "1";
  const { drive, requests } = mock((req) =>
    new URL(req.url).pathname.endsWith("/files")
      ? response({ files: [{ ...driveFile(), version }] })
      : undefined,
  );
  const [a, b] = await Promise.all([
    drive.scan(["a.pdf"]),
    drive.scan(["a.pdf"]),
  ]);
  expect(a.files["a.pdf"]!.version).toBe("1");
  expect(b.files["a.pdf"]!.version).toBe("1");
  expect(requests).toHaveLength(3);
  version = "2";
  expect((await drive.scan(["a.pdf"])).files["a.pdf"]!.version).toBe("2");
  expect(requests).toHaveLength(6);
});

it("never coalesces GET requests that reserve distinct upload IDs", async () => {
  let allocated = 0;
  const { drive, requests } = mock((req) =>
    new URL(req.url).pathname.endsWith("/generateIds")
      ? response({ ids: [`reserved-${++allocated}`] })
      : undefined,
  );
  expect(
    await Promise.all([
      drive.reserveId(),
      drive.reserveId(),
      drive.reserveId(),
    ]),
  ).toEqual(["reserved-1", "reserved-2", "reserved-3"]);
  expect(
    requests.filter((req) => req.url.includes("/generateIds")),
  ).toHaveLength(3);
});
