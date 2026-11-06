import { Platform, Plugin, requestUrl } from "obsidian";
import { CredentialStore } from "./auth/CredentialStore";
import { EncryptedConfig } from "./auth/EncryptedConfig";
import { OAuthManager, exchangeCode } from "./auth/OAuthManager";
import type { Credentials } from "./auth/CredentialEncryption";
import { DriveClient } from "./drive/DriveClient";
import type { Http } from "./drive/Http";
import { desktopGuard, VaultBackend } from "./local/VaultBackend";
import { SyncStateStore, type PrivateStorage } from "./sync/SyncStateStore";
import { SyncExecutor } from "./sync/SyncExecutor";
import { reconcile } from "./sync/ReconciliationEngine";
import type { Review } from "./sync/types";
import { confirm, downloadFile, form, pickFile } from "./ui/Dialogs";
import { SyncReviewModal } from "./ui/SyncReviewModal";
import { RemoteSyncSettings } from "./ui/SettingsTab";
import { HistoryModal } from "./ui/HistoryModal";
import { dismissNotifications, notify } from "./ui/Notifications";
export default class RemoteSyncPlugin extends Plugin {
  credentials!: CredentialStore;
  state!: SyncStateStore;
  executor: SyncExecutor | null = null;
  working = false;
  private auth: OAuthManager | null = null;
  private scanBusy = false;
  private abort = new AbortController();
  private disposed = false;
  readonly http: Http = async (req) => {
    if (this.disposed) throw new Error("Remote Sync unloaded");
    try {
      const r = await requestUrl({ ...req, throw: false });
      return {
        status: r.status,
        headers: r.headers,
        text: r.text,
        data: r.arrayBuffer,
      };
    } catch {
      throw new Error(
        "Network request failed. Check connectivity and manually rescan.",
      );
    }
  };
  async onload(): Promise<void> {
    const dir = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/private`;
    if (!(await this.app.vault.adapter.exists(dir)))
      await this.app.vault.adapter.mkdir(dir);
    const storage: PrivateStorage = {
      read: (p) => this.app.vault.adapter.read(p),
      write: (p, v) => this.app.vault.adapter.write(p, v),
      exists: (p) => this.app.vault.adapter.exists(p),
    };
    this.state = new SyncStateStore(storage, `${dir}/state`);
    await this.state.load();
    const config = new EncryptedConfig(storage, `${dir}/credentials`);
    this.credentials = new CredentialStore(await config.load(), (envelope) =>
      config.save(envelope),
    );
    this.addRibbonIcon("refresh-cw", "Sync Materials", () =>
      this.run(() => this.openReview()),
    );
    this.addCommand({
      id: "review-changes",
      name: "Review Status",
      callback: () => this.run(() => this.openReview()),
    });
    this.addCommand({
      id: "lock-credentials",
      name: "Lock Credentials",
      callback: () => this.lock(),
    });
    this.addCommand({
      id: "history",
      name: "Activity history",
      callback: () => new HistoryModal(this.app, this.state).open(),
    });
    this.addSettingTab(new RemoteSyncSettings(this.app, this));
    // No timers, events, scans, refresh grants or network requests on load.
  }
  onunload(): void {
    this.disposed = true;
    dismissNotifications();
    this.abort.abort();
    this.executor?.cancel();
    this.auth?.lock();
    this.credentials?.lock();
  }
  run(task: () => Promise<unknown>): void {
    if (this.working) {
      notify("Remote Sync: another user operation is active.", "warning");
      return;
    }
    this.working = true;
    void task()
      .catch((e) => {
        notify(
          `Remote Sync: ${e instanceof Error ? e.message : "Operation failed"}`,
          "error",
        );
      })
      .finally(() => {
        this.working = false;
      });
  }
  lock(): void {
    if (this.working || this.executor?.busy) {
      notify(
        "Remote Sync: finish or cancel the active operation before locking.",
        "warning",
      );
      return;
    }
    this.auth?.lock();
    this.auth = null;
    this.executor = null;
    this.credentials.lock();
    notify("Remote Sync: credentials locked");
  }
  async unlock(): Promise<void> {
    if (this.credentials.unlocked) return;
    const input = await form(this.app, "Unlock credentials", [
      { key: "passphrase", label: "Passphrase", secret: true },
    ]);
    if (!input) throw new Error("Unlock cancelled");
    try {
      await this.credentials.unlock(input.passphrase!);
    } finally {
      input.passphrase = "";
    }
    this.auth = null;
  }
  manager(): OAuthManager {
    return (this.auth ??= new OAuthManager(
      this.http,
      () => this.credentials.credentials,
      () => this.credentials.persist(),
    ));
  }
  drive(): DriveClient {
    const c = this.credentials.credentials;
    return new DriveClient(this.http, this.manager(), c.folderId, c.accountId);
  }
  context(): string {
    const c = this.credentials.credentials;
    return `${this.state.state.deviceId}:${c.accountId}:${c.folderId}`;
  }
  private async validateCandidate(c: Credentials): Promise<void> {
    const auth = new OAuthManager(
      this.http,
      () => c,
      async () => {},
    );
    try {
      await auth.token(true);
      const drive = new DriveClient(this.http, auth, c.folderId, c.accountId);
      const account = await drive.account();
      if (c.accountId && c.accountId !== account.id)
        throw new Error("Wrong Google account");
      c.accountId = account.id;
      c.accountEmail = account.email;
      if (c.folderId) {
        const folder = await drive.validateFolder();
        c.folderName = folder.name;
      }
    } finally {
      auth.lock();
    }
  }
  async connect(): Promise<void> {
    if (!Platform.isDesktopApp)
      throw new Error(
        "Connect on Ubuntu, then import the encrypted bundle on Android",
      );
    if (
      this.credentials.envelope &&
      !(await confirm(
        this.app,
        "Replace account",
        "The previous device-local baseline stays isolated. Export credentials first if needed.",
      ))
    )
      return;
    if (
      !(await confirm(
        this.app,
        "Google Drive permission",
        "To reliably see existing and manually uploaded files, v1 requests full Drive access. Google permits this token to manage all Drive files. Remote Sync confines its file operations to your selected owned folder. drive.file alone cannot provide complete folder visibility. Continue to Google consent?",
      ))
    )
      return;
    const input = await form(
      this.app,
      "Connect on Ubuntu",
      [
        { key: "clientId", label: "Desktop OAuth client ID" },
        {
          key: "clientSecret",
          label: "Desktop OAuth client secret",
          secret: true,
        },
        {
          key: "passphrase",
          label: "New encryption passphrase (12+ characters)",
          secret: true,
        },
        { key: "repeat", label: "Repeat passphrase", secret: true },
      ],
      "Create a Desktop app OAuth client in Google Cloud. Values stay in memory until encrypted.",
    );
    if (!input) return;
    try {
      if (input.passphrase !== input.repeat || input.passphrase!.length < 12)
        throw new Error(
          "Passphrases must match and contain at least 12 characters",
        );
      if (!input.clientId?.endsWith(".apps.googleusercontent.com"))
        throw new Error("Enter a Google Desktop OAuth client ID");
      const { desktopCode } = await import("./auth/DesktopOAuth");
      notify("Remote Sync: complete Google consent in your browser.");
      const callback = await desktopCode(
        input.clientId,
        (url) => {
          window.open(url);
        },
        this.abort.signal,
      );
      const c = await exchangeCode(
        this.http,
        input.clientId,
        input.clientSecret!,
        callback.code,
        callback.verifier,
        callback.redirectUri,
      );
      await this.validateCandidate(c);
      await this.credentials.install(c, input.passphrase!);
      this.auth?.lock();
      this.auth = null;
      notify(
        "Remote Sync: credentials encrypted. Select a remote folder, then export for Android.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async importCredentials(): Promise<void> {
    const raw = await pickFile();
    if (!raw) return;
    if (
      this.credentials.envelope &&
      !(await confirm(
        this.app,
        "Replace credentials",
        "Imported credentials replace the local encrypted credentials. Baselines stay isolated by account and folder.",
      ))
    )
      return;
    const input = await form(
      this.app,
      "Import Encrypted Credentials",
      [
        { key: "passphrase", label: "Export passphrase", secret: true },
        {
          key: "local",
          label: "Local encryption passphrase (12+ characters)",
          secret: true,
        },
        { key: "repeat", label: "Repeat local passphrase", secret: true },
      ],
      "Import transfers no baseline or history. Token refresh and selected-folder access are validated before storage.",
    );
    if (!input) return;
    try {
      if (input.local !== input.repeat)
        throw new Error("Local passphrases do not match");
      await this.credentials.import(
        raw,
        input.passphrase!,
        (c) => this.validateCandidate(c),
        input.local!,
      );
      this.auth?.lock();
      this.auth = null;
      this.executor = null;
      notify(
        "Remote Sync: imported and validated. Create materials/ before your first manual scan.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async exportCredentials(): Promise<void> {
    await this.unlock();
    if (!this.credentials.credentials.folderId)
      throw new Error("Select and validate a folder before exporting");
    await this.validateCandidate(this.credentials.credentials);
    await this.credentials.persist();
    downloadFile(
      "obsidian-remote-sync-credentials.json",
      JSON.stringify(this.credentials.envelope, null, 2),
    );
  }
  async changePassphrase(): Promise<void> {
    const input = await form(this.app, "Change passphrase", [
      { key: "old", label: "Current passphrase", secret: true },
      { key: "next", label: "New passphrase", secret: true },
      { key: "repeat", label: "Repeat new passphrase", secret: true },
    ]);
    if (!input) return;
    try {
      if (input.next !== input.repeat)
        throw new Error("Passphrases do not match");
      await this.credentials.changePassphrase(input.old!, input.next!);
      this.auth?.lock();
      this.auth = null;
      notify(
        "Remote Sync: credentials re-encrypted. Previous export files still use their original passphrases.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async chooseFolder(id: string): Promise<void> {
    await this.unlock();
    const drive = this.drive(),
      folder = await drive.validateFolder(id);
    await drive.account();
    if (this.credentials.credentials.folderId === id) return;
    if (
      !(await confirm(
        this.app,
        "Change remote folder",
        `Use ${folder.name} (${id})? The new folder uses an independent baseline; existing files are untouched.`,
      ))
    )
      return;
    const c = this.credentials.credentials,
      old = { id: c.folderId, name: c.folderName };
    c.folderId = id;
    c.folderName = folder.name;
    try {
      await this.credentials.persist();
      this.executor = null;
    } catch (e) {
      c.folderId = old.id;
      c.folderName = old.name;
      throw e;
    }
  }
  async scan(onStatus?: (message: string) => void): Promise<Review> {
    if (this.scanBusy || this.executor?.busy)
      throw new Error("Scan or Apply already active");
    this.scanBusy = true;
    try {
      onStatus?.("Unlocking credentials…");
      await this.unlock();
      const c = this.credentials.credentials;
      if (!c.folderId)
        throw new Error("Select a remote folder in Remote Sync settings");
      const localBackend = new VaultBackend(
          this.app.vault,
          await desktopGuard(this.app.vault),
        ),
        remoteBackend = this.drive();
      onStatus?.("Checking local materials…");
      const local = await localBackend.scan();
      onStatus?.("Checking Google Drive…");
      const remote = await remoteBackend.scan(),
        context = this.context();
      onStatus?.("Comparing file contents…");
      const changes = reconcile(
        local,
        remote,
        this.state.state.baselines[context] ?? {},
      );
      const observedAt = Date.now(),
        seen = (this.state.state.seen[context] ??= {});
      for (const change of changes) {
        const previous =
          seen[change.key] ??
          Object.values(seen).find(
            (o) =>
              (o.local?.path === change.local?.path && !!change.local) ||
              (o.remote?.id === change.remote?.id && !!change.remote?.id),
          );
        seen[change.key] = {
          firstSeenAt: previous?.firstSeenAt ?? observedAt,
          lastSeenAt: observedAt,
          local: change.local,
          remote: change.remote,
          classification: change.classification,
        };
      }
      this.state.state.observations.push({
        at: observedAt,
        context,
        files: changes,
        status: "Success",
      });
      onStatus?.("Finishing the review…");
      this.state.prune();
      await this.state.save();
      this.executor = new SyncExecutor(
        localBackend,
        remoteBackend,
        this.state,
        () => this.context(),
      );
      return { local, remote, changes, context };
    } catch (error) {
      const context = this.credentials.unlocked
        ? this.context()
        : `${this.state.state.deviceId}:locked`;
      this.state.state.observations.push({
        at: Date.now(),
        context,
        files: [],
        status: "Failed",
        reason:
          "Manual scan failed or was cancelled. No reconciliation or file operations were applied.",
      });
      this.state.prune();
      await this.state.save();
      throw error;
    } finally {
      this.scanBusy = false;
    }
  }
  async openReview(): Promise<void> {
    const modal = new SyncReviewModal(this.app, this);
    modal.open();
    await modal.loadReview();
  }
}
