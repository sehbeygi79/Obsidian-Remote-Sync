import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import RemoteSyncPlugin from "../src/main";
import { CredentialStore } from "../src/auth/CredentialStore";
import {
  decryptConfiguration,
  encrypt,
  DRIVE_SCOPE,
  type Credentials,
} from "../src/auth/CredentialEncryption";
import { validateConfiguration } from "../src/auth/RemoteConfiguration";
import { OAuthManager, exchangeCode } from "../src/auth/OAuthManager";
import { DriveClient } from "../src/drive/DriveClient";
import type { HttpRequest } from "../src/drive/Http";
import { SyncExecutor } from "../src/sync/SyncExecutor";
import { reconcile } from "../src/sync/ReconciliationEngine";
import { baseline, Backend, bytes, memoryStore } from "./helpers";
import { timeRemaining } from "../src/ui/TokenStatus";
import { accountAvatar } from "../src/ui/AccountIdentity";
import { UiElement } from "./ui-host";

const pass = "a long device passphrase";
const credentials = (
  accountId = "google-one",
  folderId = "folder-one",
): Credentials => ({
  version: 1,
  clientType: "desktop",
  clientId: `${accountId}.apps.googleusercontent.com`,
  clientSecret: `${accountId}-secret`,
  refreshToken: `${accountId}-refresh`,
  scopes: [DRIVE_SCOPE],
  accountId,
  accountEmail: `${accountId}@example.test`,
  folderId,
  folderName: folderId,
});
const response = (value: unknown, status = 200) => ({
  status,
  headers: {},
  text: JSON.stringify(value),
  data: bytes(""),
});
async function fixture() {
  const save = vi.fn(async () => {}),
    store = new CredentialStore(null, save);
  await store.install(credentials(), pass);
  const first = store.activeRemote!.id,
    accountOne = store.accounts[0]!.id;
  const second = await store.addRemote(
    accountOne,
    "folder-two",
    "Folder two",
    "Second remote",
  );
  const accountTwo = await store.addAccount(credentials("google-two", ""));
  const third = await store.addRemote(
    accountTwo,
    "folder-three",
    "Folder three",
    "Other account remote",
  );
  return { store, save, first, second, third, accountOne, accountTwo };
}
function plugin(store: CredentialStore) {
  const plugin = new RemoteSyncPlugin({} as App, {
    id: "obsidian-remote-sync",
    name: "Remote Sync",
    version: "1.5.0",
    minAppVersion: "1.8.7",
    description: "",
    author: "",
  });
  plugin.credentials = store;
  plugin.state = memoryStore();
  return plugin;
}

afterEach(() => vi.restoreAllMocks());

describe("encrypted multi-remote configuration", () => {
  it("migrates a legacy account on unlock and keeps its original storage context", async () => {
    const legacy = await encrypt(credentials(), pass),
      save = vi.fn(async () => {}),
      store = new CredentialStore(legacy.envelope, save);
    await store.unlock(pass);
    expect(store.envelope!.version).toBe(2);
    expect(store.credentials).toEqual(credentials());
    expect(store.accounts).toHaveLength(1);
    expect(store.remotes).toHaveLength(1);
    expect(store.accounts[0]!.credentials.folderId).toBe("");
    const app = plugin(store);
    expect(app.context()).toBe(
      `${app.state.state.deviceId}:google-one:folder-one`,
    );
    const remoteId = store.activeRemote!.id;
    store.lock();
    await store.unlock(pass);
    expect(store.activeRemote!.id).toBe(remoteId);
    expect(save).toHaveBeenCalledOnce();
  });
  it("keeps a legacy envelope recoverable and stays locked when migration cannot be saved", async () => {
    const legacy = await encrypt(credentials(), pass),
      store = new CredentialStore(legacy.envelope, async () => {
        throw Error("disk full");
      });
    await expect(store.unlock(pass)).rejects.toThrow("disk full");
    expect(store.envelope).toBe(legacy.envelope);
    expect(store.unlocked).toBe(false);
    expect(
      (await decryptConfiguration(legacy.envelope, pass)).configuration
        .accounts,
    ).toHaveLength(1);
  });
  it("supports several folders sharing a grant and a remote on another account", async () => {
    const f = await fixture();
    expect(f.store.accounts).toHaveLength(2);
    expect(f.store.remotes).toHaveLength(3);
    expect(
      f.store.remotes.filter((r) => r.accountRef === f.accountOne),
    ).toHaveLength(2);
    await f.store.selectRemote(f.first);
    expect(f.store.credentials.accountId).toBe("google-one");
    expect(f.store.credentials.folderId).toBe("folder-one");
    await f.store.selectRemote(f.third);
    expect(f.store.credentials.accountId).toBe("google-two");
    expect(JSON.stringify(f.store.envelope)).not.toContain(
      "google-one-refresh",
    );
    f.store.lock();
    await f.store.unlock(pass);
    expect(f.store.remotes).toHaveLength(3);
  });
  it("keeps account photos and Google-reported refresh deadlines inside encrypted storage across unlock", async () => {
    const f = await fixture(),
      deadline = Date.now() + 86400000;
    await f.store.update((next) => {
      const account = next.accounts.find((a) => a.id === f.accountOne)!;
      account.credentials.photoUrl = "https://lh3.googleusercontent.com/photo";
      account.credentials.displayName = "Person";
      account.credentials.refreshTokenExpiresAt = deadline;
    });
    expect(JSON.stringify(f.store.envelope)).not.toContain(
      "googleusercontent.com/photo",
    );
    f.store.lock();
    await f.store.unlock(pass);
    expect(f.store.account(f.accountOne)).toMatchObject({
      photoUrl: "https://lh3.googleusercontent.com/photo",
      displayName: "Person",
      refreshTokenExpiresAt: deadline,
    });
    expect(f.store.account(f.accountTwo).refreshTokenExpiresAt).toBeUndefined();
  });
  it("rejects duplicate targets, dangling accounts and duplicate account identities", async () => {
    const f = await fixture(),
      before = structuredClone(f.store.configuration);
    await expect(
      f.store.addRemote(f.accountOne, "folder-one", "Duplicate", "Duplicate"),
    ).rejects.toThrow("already");
    await expect(
      f.store.addRemote("absent", "another", "Missing", "Missing"),
    ).rejects.toThrow("Invalid");
    expect(f.store.configuration).toEqual(before);
    const invalid = structuredClone(before);
    invalid.accounts.push({ ...invalid.accounts[0]!, id: "different-record" });
    expect(() => validateConfiguration(invalid)).toThrow("duplicate");
  });
  it("validates a configuration edit before exposing it and keeps the old selection if storage fails", async () => {
    const f = await fixture(),
      before = structuredClone(f.store.configuration),
      envelope = f.store.envelope;
    f.save.mockRejectedValueOnce(Error("disk full"));
    await expect(f.store.selectRemote(f.first)).rejects.toThrow("disk full");
    expect(f.store.configuration).toEqual(before);
    expect(f.store.envelope).toBe(envelope);
    await f.store.selectRemote(f.first);
    expect(f.store.activeRemote!.id).toBe(f.first);
  });
  it("updates an existing account grant without duplicating profiles", async () => {
    const f = await fixture();
    const id = await f.store.addAccount({
      ...credentials(),
      refreshToken: "replacement-grant",
    });
    expect(id).toBe(f.accountOne);
    expect(f.store.accounts).toHaveLength(2);
    expect(f.store.remotes).toHaveLength(3);
    expect(f.store.account(f.accountOne).refreshToken).toBe(
      "replacement-grant",
    );
    expect(f.store.account(f.accountTwo).refreshToken).toBe(
      "google-two-refresh",
    );
  });
  it("exports only one remote and its grant and merges it into another device", async () => {
    const f = await fixture(),
      envelope = await f.store.export(f.second);
    const payload = (await decryptConfiguration(envelope, pass)).configuration;
    expect(payload.accounts).toHaveLength(1);
    expect(payload.remotes).toHaveLength(1);
    expect(payload.remotes[0]!.id).toBe(f.second);
    expect(payload.accounts[0]!.credentials.accountId).toBe("google-one");
    const destination = new CredentialStore(null, async () => {});
    await destination.install(credentials("existing", "existing-folder"), pass);
    const validate = vi.fn(async () => {});
    await destination.import(JSON.stringify(envelope), pass, validate);
    expect(validate).toHaveBeenCalledOnce();
    expect(destination.accounts).toHaveLength(2);
    expect(destination.remotes).toHaveLength(2);
    expect(destination.activeRemote!.folderId).toBe("folder-two");
    await destination.import(JSON.stringify(envelope), pass, validate);
    expect(destination.accounts).toHaveLength(2);
    expect(destination.remotes).toHaveLength(2);
  });
  it("merges legacy exports while retaining unrelated profiles and validates before writing", async () => {
    const f = await fixture(),
      legacy = await encrypt(
        credentials("third-account", "fourth-folder"),
        pass,
      );
    await f.store.import(JSON.stringify(legacy.envelope), pass, async () => {});
    expect(f.store.remotes).toHaveLength(4);
    expect(f.store.accounts).toHaveLength(3);
    const before = structuredClone(f.store.configuration);
    f.save.mockClear();
    await expect(
      f.store.import(JSON.stringify(legacy.envelope), pass, async () => {
        throw Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(f.save).not.toHaveBeenCalled();
    expect(f.store.configuration).toEqual(before);
  });
  it("changes the passphrase for all accounts and profiles together", async () => {
    const f = await fixture();
    await f.store.changePassphrase(pass, "another device passphrase");
    await expect(
      decryptConfiguration(f.store.envelope!, pass),
    ).rejects.toThrow();
    const config = (
      await decryptConfiguration(f.store.envelope!, "another device passphrase")
    ).configuration;
    expect(config.remotes).toHaveLength(3);
    expect(config.accounts).toHaveLength(2);
  });
  it("removes a profile separately from its shared account and permits removing the last account", async () => {
    const f = await fixture();
    await f.store.removeRemote(f.first);
    expect(f.store.accounts).toHaveLength(2);
    expect(f.store.remotes).toHaveLength(2);
    await f.store.removeAccount(f.accountOne);
    expect(f.store.remotes.map((r) => r.id)).toEqual([f.third]);
    await f.store.removeAccount(f.accountTwo);
    expect(f.store.accounts).toHaveLength(0);
    expect(f.store.remotes).toHaveLength(0);
    f.store.lock();
    await f.store.unlock(pass);
    expect(f.store.accounts).toHaveLength(0);
  });
  it("cannot restore decrypted credentials after Lock interrupts an in-flight save", async () => {
    const f = await fixture();
    let release!: () => void;
    f.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const update = f.store.renameRemote(f.first, "Renamed");
    await vi.waitFor(() => expect(release).toBeDefined());
    f.store.lock();
    release();
    await expect(update).rejects.toThrow("locked");
    expect(f.store.unlocked).toBe(false);
    expect(() => f.store.account(f.accountOne)).toThrow("locked");
  });
});

describe("remote identity and token isolation", () => {
  it("keeps baselines independent and invalidates a review even after switching away and back", async () => {
    const f = await fixture(),
      app = plugin(f.store);
    await app.selectRemote(f.first);
    const firstContext = app.context(),
      version = app.selectionVersion;
    app.state.state.baselines[firstContext] = { "a.pdf": baseline() };
    await app.selectRemote(f.second);
    expect(app.context()).not.toBe(firstContext);
    expect(app.state.state.baselines[app.context()]).toBeUndefined();
    await app.selectRemote(f.first);
    expect(app.context()).toBe(firstContext);
    expect(app.selectionVersion).toBeGreaterThan(version);
    expect(app.state.state.baselines[firstContext]!["a.pdf"]).toEqual(
      baseline(),
    );
    const local = new Backend({ "a.pdf": "original" }),
      remote = new Backend({}, true),
      ls = await local.scan(),
      rs = await remote.scan();
    const review = {
      local: ls,
      remote: rs,
      context: firstContext,
      changes: reconcile(ls, rs, {}),
    };
    const executor = new SyncExecutor(
      local,
      remote,
      app.state,
      () => app.context(),
      () => app.selectionVersion === version,
    );
    await expect(
      executor.apply(
        review,
        [{ change: review.changes[0]!, action: "upload" }],
        true,
      ),
    ).rejects.toThrow("Needs Rescan");
    expect(remote.calls).toEqual([]);
  });
  it("blocks remote switching while applying and clears every account's token cache on Lock", async () => {
    const f = await fixture(),
      app = plugin(f.store);
    app.executor = { busy: true } as SyncExecutor;
    await expect(app.selectRemote(f.first)).rejects.toThrow("Finish or cancel");
    app.executor = null;
    const one = app.manager(f.accountOne),
      two = app.manager(f.accountTwo);
    const lockOne = vi.spyOn(one, "lock"),
      lockTwo = vi.spyOn(two, "lock");
    app.lock();
    expect(lockOne).toHaveBeenCalledOnce();
    expect(lockTwo).toHaveBeenCalledOnce();
    expect(f.store.unlocked).toBe(false);
  });
  it("uses the issuing account's refresh grant and persists rotation without changing another account", async () => {
    const f = await fixture(),
      app = plugin(f.store);
    const requests: HttpRequest[] = [];
    vi.spyOn(app, "http").mockImplementation(async (req) => {
      requests.push(req);
      const form = new URLSearchParams(req.body as string),
        account = form.get("client_id")!.split(".")[0];
      return response({
        access_token: `access-${account}`,
        expires_in: 3600,
        refresh_token: `rotated-${account}`,
      });
    });
    const manager = app.manager(f.accountOne);
    await app.selectRemote(f.third);
    expect(await manager.token()).toBe("access-google-one");
    expect(f.store.account(f.accountOne).refreshToken).toBe(
      "rotated-google-one",
    );
    expect(f.store.account(f.accountTwo).refreshToken).toBe(
      "google-two-refresh",
    );
    expect(await app.manager(f.accountTwo).token()).toBe("access-google-two");
    expect(
      new URLSearchParams(requests[0]!.body as string).get("refresh_token"),
    ).toBe("google-one-refresh");
    expect(app.tokenStatus(f.accountOne).accessExpiresAt).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe("expiry information and Google photos", () => {
  it("records Google-reported refresh deadlines on exchange and refresh, without guessing missing deadlines", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    const exchanged = await exchangeCode(
      async () =>
        response({
          refresh_token: "grant",
          scope: DRIVE_SCOPE,
          refresh_token_expires_in: 86400,
        }),
      "client",
      "secret",
      "code",
      "verifier",
      "uri",
    );
    expect(exchanged.refreshTokenExpiresAt).toBe(87400000);
    const c = credentials(),
      save = vi.fn(async () => {});
    const manager = new OAuthManager(
      async () =>
        response({
          access_token: "access",
          expires_in: 3600,
          refresh_token_expires_in: 120,
        }),
      () => c,
      save,
    );
    await manager.token();
    expect(manager.expiresAt).toBe(4600000);
    expect(c.refreshTokenExpiresAt).toBe(1120000);
    expect(save).toHaveBeenCalledOnce();
    const unknown = credentials(),
      second = new OAuthManager(
        async () => response({ access_token: "access", expires_in: 3600 }),
        () => unknown,
        async () => {},
      );
    await second.token();
    expect(unknown.refreshTokenExpiresAt).toBeUndefined();
    expect(timeRemaining(1120000, 1000000)).toBe("2m 0s remaining");
    expect(timeRemaining(1, 1000000)).toBe("Expired");
  });
  it("requires reconnect after a rejected refresh and rolls back rotation if it cannot be stored", async () => {
    const c = credentials(),
      manager = new OAuthManager(
        async () => response({}, 400),
        () => c,
        async () => {},
      );
    await expect(manager.token()).rejects.toThrow("expired");
    expect(manager.needsReconnect).toBe(true);
    const failed = new OAuthManager(
      async () =>
        response({
          access_token: "access",
          expires_in: 3600,
          refresh_token: "new",
        }),
      () => c,
      async () => {
        throw Error("disk");
      },
    );
    await expect(failed.token()).rejects.toThrow("disk");
    expect(c.refreshToken).toBe("google-one-refresh");
    expect(failed.expiresAt).toBeUndefined();
  });
  it("gets profile photos through the existing Drive account request and uses a safe avatar fallback", async () => {
    const http = vi.fn(async () =>
      response({
        user: {
          permissionId: "google-one",
          emailAddress: "user@example.test",
          displayName: "Person",
          photoLink: "https://lh3.googleusercontent.com/example-photo",
        },
      }),
    );
    const drive = new DriveClient(
      http,
      { token: async () => "token", lock: () => {} },
      "folder",
      "google-one",
    );
    const user = await drive.account();
    expect(user.photoUrl).toBe(
      "https://lh3.googleusercontent.com/example-photo",
    );
    const root = new UiElement();
    accountAvatar(root as unknown as HTMLElement, {
      ...credentials(),
      photoUrl: user.photoUrl,
      displayName: user.displayName,
    });
    const img = root.querySelector("img")!;
    expect(img.attributes.referrerpolicy).toBe("no-referrer");
    img.listeners.error!();
    expect(root.querySelector("img")).toBeNull();
    accountAvatar(root as unknown as HTMLElement, {
      ...credentials(),
      photoUrl: "https://attacker.example/track",
    });
    expect(root.querySelector("img")).toBeNull();
  });
});

it("applies independently to two remote folders while preserving both confirmed baselines and destination labels", async () => {
  const f = await fixture(),
    app = plugin(f.store),
    local = new Backend({ "a.pdf": "same local material" });
  const contexts: string[] = [];
  for (const [id, name] of [
    [f.first, "Primary"],
    [f.second, "Archive"],
  ]) {
    await app.selectRemote(id!);
    const context = app.context(),
      version = app.selectionVersion,
      remote = new Backend({}, true),
      ls = await local.scan(),
      rs = await remote.scan();
    contexts.push(context);
    const review = {
      local: ls,
      remote: rs,
      changes: reconcile(ls, rs, app.state.state.baselines[context] ?? {}),
      context,
      profileId: id,
      remoteName: name,
      selectionVersion: version,
    };
    const executor = new SyncExecutor(
      local,
      remote,
      app.state,
      () => app.context(),
      () => version === app.selectionVersion,
    );
    const results = await executor.apply(
      review,
      [{ change: review.changes[0]!, action: "upload" }],
      true,
    );
    expect(results[0]!.status).toBe("Success");
    expect(remote.files["a.pdf"]).toBeDefined();
  }
  expect(new Set(contexts).size).toBe(2);
  expect(
    contexts.every((c) =>
      Object.values(app.state.state.baselines[c] ?? {}).some(
        (record) => record.path === "a.pdf" && record.syncedAt > 0,
      ),
    ),
  ).toBe(true);
  expect(app.state.state.operations.map((op) => op.remoteName)).toEqual([
    "Primary",
    "Archive",
  ]);
});

it("removing an account requires confirmation and retains its baselines and unresolved history", async () => {
  const { Modal } = await import("./ui-host");
  const f = await fixture(),
    app = plugin(f.store);
  await app.selectRemote(f.first);
  const context = app.context();
  app.state.state.baselines[context] = { "a.pdf": baseline() };
  app.state.state.journal = [
    {
      id: "pending",
      session: "batch",
      at: Date.now(),
      context,
      path: "a.pdf",
      action: "upload",
      status: "Running",
      before: { local: null, remote: null },
    },
  ];
  const original = structuredClone(app.state.state);
  const remove = app.removeAccount(f.accountOne);
  await vi.waitFor(() => expect(Modal.opened.length).toBeGreaterThan(0));
  expect(f.store.accounts).toHaveLength(2);
  Modal.opened.at(-1)!.contentEl.all((el) => el.textContent === "Confirm")[0]!
    .listeners.click!();
  await remove;
  expect(f.store.accounts).toHaveLength(1);
  expect(app.state.state).toEqual(original);
});

it.each([-1, 0, NaN, "3600"])(
  "rejects an invalid refresh-token lifetime (%s) instead of displaying an invented countdown",
  async (value) => {
    const c = credentials(),
      manager = new OAuthManager(
        async () =>
          response({
            access_token: "access",
            expires_in: 3600,
            refresh_token_expires_in: value,
          }),
        () => c,
        async () => {},
      );
    await expect(manager.token()).rejects.toThrow("lifetime");
    expect(c.refreshTokenExpiresAt).toBeUndefined();
  },
);
