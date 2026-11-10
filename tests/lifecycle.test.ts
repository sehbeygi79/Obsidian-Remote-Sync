import { describe, it, expect, vi } from "vitest";
import { requestUrl, Platform } from "obsidian";
import RemoteSyncPlugin from "../src/main";
import type { App } from "obsidian";
import type { Review } from "../src/sync/types";
import { Modal } from "./ui-host";
import { baseline, snapshot } from "./helpers";
function fixture() {
  const data = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (p: string) => data.has(p)),
    mkdir: vi.fn(async (p: string) => {
      data.set(p, "");
    }),
    read: vi.fn(async (p: string) => data.get(p)!),
    write: vi.fn(async (p: string, v: string) => {
      data.set(p, v);
    }),
  };
  const plugin = new RemoteSyncPlugin({} as App, {
    id: "obsidian-remote-sync",
    name: "Remote Sync",
    version: "1.3.0",
    minAppVersion: "1.8.7",
    description: "",
    author: "",
  });
  plugin.app = { vault: { adapter, configDir: ".obsidian" } } as unknown as App;
  return { plugin, adapter, data };
}
describe("manual lifecycle", () => {
  it("keeps folder choices on this device and isolates sync contexts", async () => {
    const f = fixture();
    await f.plugin.onload();
    Object.assign(f.plugin.app.vault.adapter, {
      stat: async (p: string) =>
        ["", "Notes"].includes(p)
          ? { type: "folder", size: 0, mtime: 0, ctime: 0 }
          : null,
    });
    await f.plugin.credentials.install(
      {
        version: 1,
        clientType: "desktop",
        clientId: "desktop.apps.googleusercontent.com",
        clientSecret: "secret",
        refreshToken: "refresh",
        scopes: ["https://www.googleapis.com/auth/drive"],
        accountId: "account",
        accountEmail: "user@test",
        folderId: "folder",
        folderName: "Remote",
      },
      "a long passphrase",
    );
    const original = f.plugin.context();
    const version = f.plugin.selectionVersion;
    await f.plugin.addLocalFolder("./");
    const root = f.plugin.context();
    expect(root).not.toBe(original);
    expect(f.plugin.selectionVersion).toBeGreaterThan(version);
    await f.plugin.addLocalFolder("./Notes/");
    await expect(f.plugin.addLocalFolder("Notes")).rejects.toThrow(
      "already configured",
    );
    expect(f.plugin.context()).not.toBe(root);
    await f.plugin.selectLocalFolder("materials");
    expect(f.plugin.context()).toBe(original);
    const saved = new (
      f.plugin.state
        .constructor as typeof import("../src/sync/SyncStateStore").SyncStateStore
    )(
      {
        read: f.adapter.read,
        write: f.adapter.write,
        exists: f.adapter.exists,
      },
      `${f.plugin.privateDirectory}/state`,
    );
    await saved.load();
    expect(saved.state.localFolders).toEqual(["materials", "", "Notes"]);
    expect(saved.state.activeLocalFolder).toBe("materials");
    f.plugin.onunload();
  });
  it("opens Review Status before awaiting the first scan", async () => {
    const f = fixture();
    await f.plugin.onload();
    let finish!: (review: Review) => void;
    const scan = vi.spyOn(f.plugin, "scan").mockReturnValue(
      new Promise<Review>((resolve) => {
        finish = resolve;
      }),
    );
    const opening = f.plugin.openReview();
    const modal = Modal.opened.at(-1)!;
    expect(modal.contentEl.querySelector("h2")!.textContent).toBe(
      "Review Status",
    );
    expect(
      modal.contentEl.querySelector(".remote-sync-scan-progress"),
    ).not.toBeNull();
    expect(scan).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    modal.close();
    finish({
      local: snapshot(),
      remote: snapshot(),
      changes: [],
      context: "test",
    });
    await opening;
    f.plugin.onunload();
  });
  it("loads and unloads without network, scanning, or watchers", async () => {
    vi.mocked(requestUrl).mockClear();
    const f = fixture();
    await f.plugin.onload();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(f.plugin.credentials.unlocked).toBe(false);
    expect(f.plugin.executor).toBeNull();
    f.plugin.onunload();
    expect(requestUrl).not.toHaveBeenCalled();
  });
  it("startup writes only its private directory", async () => {
    const f = fixture();
    await f.plugin.onload();
    expect(
      f.adapter.mkdir.mock.calls.every(([p]) =>
        p.includes("/plugins/obsidian-remote-sync/private"),
      ),
    ).toBe(true);
    expect(f.adapter.write).not.toHaveBeenCalled();
  });
});
describe("manual observation pipeline", () => {
  it("persists first/last observations across scans without advancing confirmed baseline", async () => {
    const f = fixture();
    await f.plugin.onload();
    const adapter = f.plugin.app.vault.adapter;
    Object.assign(adapter, {
      stat: vi.fn(async (p: string) =>
        p === "materials"
          ? { type: "folder", mtime: 1, ctime: 1, size: 0 }
          : p === "materials/a.pdf"
            ? { type: "file", mtime: 1000, ctime: 1, size: 8 }
            : null,
      ),
      list: vi.fn(async () => ({ files: ["materials/a.pdf"], folders: [] })),
      readBinary: vi.fn(
        async () => new TextEncoder().encode("original").buffer,
      ),
    });
    vi.spyOn(f.plugin, "http").mockImplementation(async (req) => {
      const value = req.url.includes("oauth2.googleapis.com")
        ? {
            access_token: "access",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/drive",
          }
        : req.url.includes("/about?")
          ? { user: { permissionId: "account", emailAddress: "user@test" } }
          : req.url.includes("/files/folder?")
            ? {
                id: "folder",
                name: "Materials",
                mimeType: "application/vnd.google-apps.folder",
                ownedByMe: true,
                capabilities: { canAddChildren: true },
              }
            : { files: [] };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify(value),
        data: new ArrayBuffer(0),
      };
    });
    await f.plugin.credentials.install(
      {
        version: 1,
        clientType: "desktop",
        clientId: "desktop.apps.googleusercontent.com",
        clientSecret: "secret",
        refreshToken: "refresh",
        scopes: ["https://www.googleapis.com/auth/drive"],
        accountId: "account",
        accountEmail: "user@test",
        folderId: "folder",
        folderName: "Materials",
      },
      "a long passphrase",
    );
    const first = await f.plugin.scan();
    expect(first.changes[0]!.classification).toBe("Local addition");
    expect(f.plugin.state.state.baselines).toEqual({});
    const key = first.changes[0]!.key,
      context = first.context;
    f.plugin.state.state.seen[context]![key]!.firstSeenAt = 123;
    const second = await f.plugin.scan();
    expect(second.changes[0]!.classification).toBe("Local addition");
    expect(f.plugin.state.state.seen[context]![key]!.firstSeenAt).toBe(123);
    expect(f.plugin.state.state.observations).toHaveLength(2);
    expect(f.plugin.state.state.baselines).toEqual({});
    const confirmed = baseline();
    f.plugin.state.state.baselines[context] = { [confirmed.key]: confirmed };
    vi.mocked(adapter.readBinary).mockClear();
    const selectionVersion = f.plugin.selectionVersion;
    await f.plugin.saveIgnorePatterns("# private file\nmaterials/a.pdf\n");
    expect(f.plugin.selectionVersion).toBeGreaterThan(selectionVersion);
    expect(f.plugin.executor).toBeNull();
    const ignored = await f.plugin.scan();
    expect(ignored.changes).toEqual([]);
    expect(ignored.local.files).toEqual({});
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(f.plugin.state.state.baselines[context]).toEqual({
      [confirmed.key]: confirmed,
    });
    await f.plugin.saveIgnorePatterns("");
    expect((await f.plugin.scan()).changes).toHaveLength(1);
    const stored = [...f.data.values()].join("");
    expect(stored).not.toContain('"refreshToken"');
    expect(stored).not.toContain('"clientSecret"');
    f.plugin.onunload();
  });
});
it("records a failed missing-root scan without network or baseline changes", async () => {
  const f = fixture();
  await f.plugin.onload();
  Object.assign(f.plugin.app.vault.adapter, { stat: async () => null });
  await f.plugin.credentials.install(
    {
      version: 1,
      clientType: "desktop",
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "client-secret",
      refreshToken: "refresh-secret",
      scopes: ["https://www.googleapis.com/auth/drive"],
      accountId: "account",
      accountEmail: "user@test",
      folderId: "folder",
      folderName: "Materials",
    },
    "a long passphrase",
  );
  const http = vi.spyOn(f.plugin, "http");
  await expect(f.plugin.scan()).rejects.toThrow("missing");
  expect(http).not.toHaveBeenCalled();
  expect(f.plugin.state.state.baselines).toEqual({});
  expect(f.plugin.state.state.observations.at(-1)!.status).toBe("Failed");
  expect(JSON.stringify(f.plugin.state.state.observations)).not.toContain(
    "refresh-secret",
  );
  f.plugin.onunload();
});

it("hides account identity and photos immediately when credentials are locked through a command", async () => {
  const f = fixture();
  await f.plugin.onload();
  await f.plugin.credentials.install(
    {
      version: 1,
      clientType: "desktop",
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "secret",
      refreshToken: "refresh",
      scopes: ["https://www.googleapis.com/auth/drive"],
      accountId: "account",
      accountEmail: "person@example.test",
      folderId: "folder",
      folderName: "Materials",
      photoUrl: "https://lh3.googleusercontent.com/example",
    },
    "a long passphrase",
  );
  const registrations = (f.plugin as unknown as { registrations: unknown[][] })
    .registrations;
  const tab = registrations
    .flat()
    .find(
      (item) => typeof item === "object" && item !== null && "display" in item,
    ) as { display: () => void; containerEl: import("./ui-host").UiElement };
  Object.defineProperty(tab.containerEl, "isConnected", { value: true });
  tab.display();
  expect(tab.containerEl.querySelector("img")).not.toBeNull();
  f.plugin.lock();
  expect(tab.containerEl.querySelector("img")).toBeNull();
  expect(
    tab.containerEl.all((el) => el.textContent.includes("person@example.test")),
  ).toHaveLength(0);
  f.plugin.onunload();
});

it("uses the requested two-line Google permission text before opening consent", async () => {
  const f = fixture(),
    desktop = Platform.isDesktopApp;
  await f.plugin.onload();
  Object.assign(Platform, { isDesktopApp: true });
  vi.mocked(requestUrl).mockClear();
  try {
    const connecting = f.plugin.connect();
    const modal = Modal.opened.at(-1)!;
    expect(
      modal.contentEl.querySelector(".remote-sync-permission-copy")!
        .textContent,
    ).toBe(
      "Remote Sync requires full drive access but confines its file operations to your selected folder.\nContinue to Google consent?",
    );
    modal.close();
    await connecting;
    expect(requestUrl).not.toHaveBeenCalled();
  } finally {
    Object.assign(Platform, { isDesktopApp: desktop });
    f.plugin.onunload();
  }
});

it("keeps first-scan equality and old baselines compatible with MD5-only Drive metadata", async () => {
  const f = fixture();
  await f.plugin.onload();
  const content = new TextEncoder().encode("original").buffer;
  const confirmed = baseline();
  confirmed.remoteId = "id-a";
  confirmed.remote!.id = "id-a";
  Object.assign(f.plugin.app.vault.adapter, {
    stat: async (path: string) =>
      path === "materials"
        ? { type: "folder", mtime: 1, ctime: 1, size: 0 }
        : path === "materials/a.pdf"
          ? { type: "file", mtime: 1000, ctime: 1, size: 8 }
          : null,
    list: async () => ({ files: ["materials/a.pdf"], folders: [] }),
    readBinary: async () => content.slice(0),
  });
  vi.spyOn(f.plugin, "http").mockImplementation(async (req) => {
    const value = req.url.includes("oauth2.googleapis.com")
      ? {
          access_token: "access",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/drive",
        }
      : req.url.includes("/about?")
        ? { user: { permissionId: "account", emailAddress: "user@test" } }
        : req.url.includes("/files/folder?")
          ? {
              id: "folder",
              name: "Remote",
              mimeType: "application/vnd.google-apps.folder",
              ownedByMe: true,
              capabilities: { canAddChildren: true },
            }
          : {
              files: [
                {
                  id: "id-a",
                  name: "a.pdf",
                  mimeType: "application/octet-stream",
                  size: "8",
                  modifiedTime: new Date(1000).toISOString(),
                  md5Checksum: confirmed.hash!.md5,
                  version: "1",
                  parents: ["folder"],
                  ownedByMe: true,
                  capabilities: {
                    canDownload: true,
                    canEdit: true,
                    canTrash: true,
                  },
                },
              ],
            };
    return {
      status: 200,
      headers: {},
      text: JSON.stringify(value),
      data: new ArrayBuffer(0),
    };
  });
  await f.plugin.credentials.install(
    {
      version: 1,
      clientType: "desktop",
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "secret",
      refreshToken: "refresh",
      scopes: ["https://www.googleapis.com/auth/drive"],
      accountId: "account",
      accountEmail: "user@test",
      folderId: "folder",
      folderName: "Remote",
    },
    "a long passphrase",
  );
  const first = await f.plugin.scan();
  expect(first.changes[0]!.classification).toBe("Equal contents");
  expect(first.local.files["a.pdf"]!.hashes.md5).toBe(confirmed.hash!.md5);
  f.plugin.state.state.baselines[first.context] = {
    [confirmed.key]: { ...confirmed, hash: { md5: confirmed.hash!.md5 } },
  };
  expect((await f.plugin.scan()).changes[0]!.classification).toBe(
    "Synchronized",
  );
  f.plugin.onunload();
});
