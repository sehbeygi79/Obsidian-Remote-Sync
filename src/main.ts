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
import {
  reconcile,
  sameVersion,
  legacyHashPaths,
} from "./sync/ReconciliationEngine";
import type { Review } from "./sync/types";
import { confirm, downloadFile, form, pickFile } from "./ui/Dialogs";
import { SyncReviewModal } from "./ui/SyncReviewModal";
import { RemoteSyncSettings } from "./ui/SettingsTab";
import { HistoryModal } from "./ui/HistoryModal";
import { dismissNotifications, notify } from "./ui/Notifications";
import { localRoot, ROOT } from "./utils/paths";
import { IgnoreRules } from "./utils/IgnoreRules";
export default class RemoteSyncPlugin extends Plugin {
  credentials!: CredentialStore;
  state!: SyncStateStore;
  executor: SyncExecutor | null = null;
  working = false;
  private settingsTab?: RemoteSyncSettings;
  private auth = new Map<string, OAuthManager>();
  selectionVersion = 0;
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
    this.addRibbonIcon("refresh-cw", "Remote Sync", () =>
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
    this.settingsTab = new RemoteSyncSettings(this.app, this);
    this.addSettingTab(this.settingsTab);
    // No timers, events, scans, refresh grants or network requests on load.
  }
  onunload(): void {
    this.disposed = true;
    dismissNotifications();
    this.abort.abort();
    this.executor?.cancel();
    this.clearAuth();
    this.credentials?.lock();
    this.settingsTab?.hide();
    if (this.settingsTab?.containerEl.isConnected)
      this.settingsTab.containerEl.empty();
  }
  run(task: () => Promise<unknown>): void {
    if (this.disposed) return;
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
    this.clearAuth();
    this.executor = null;
    this.credentials.lock();
    this.invalidateReviews();
    notify("Remote Sync: credentials locked");
  }
  async unlock(): Promise<void> {
    if (this.disposed) throw new Error("Remote Sync unloaded");
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
    this.clearAuth();
  }
  private clearAuth(): void {
    for (const manager of this.auth.values()) manager.lock();
    this.auth.clear();
  }
  private ensureIdle(): void {
    if (this.disposed) throw new Error("Remote Sync unloaded");
    if (this.scanBusy || this.executor?.busy)
      throw new Error("Finish or cancel the active scan or sync first");
  }
  private invalidateReviews(): void {
    this.selectionVersion++;
    this.executor = null;
    if (this.settingsTab?.containerEl.isConnected) this.settingsTab.display();
  }
  manager(
    accountRef = this.credentials.configuration.activeAccountId,
  ): OAuthManager {
    let manager = this.auth.get(accountRef);
    if (!manager) {
      this.credentials.account(accountRef);
      manager = new OAuthManager(
        this.http,
        () => this.credentials.account(accountRef),
        () => this.credentials.persist(),
      );
      this.auth.set(accountRef, manager);
    }
    return manager;
  }
  tokenStatus(accountRef: string): {
    accessExpiresAt?: number;
    refreshExpiresAt?: number;
    needsReconnect: boolean;
  } {
    const manager = this.auth.get(accountRef);
    return {
      accessExpiresAt: manager?.expiresAt,
      refreshExpiresAt:
        this.credentials.account(accountRef).refreshTokenExpiresAt,
      needsReconnect: manager?.needsReconnect ?? false,
    };
  }
  drive(
    accountRef = this.credentials.configuration.activeAccountId,
    folderId?: string,
    isIgnored?: (path: string) => boolean,
  ): DriveClient {
    const c = this.credentials.account(accountRef),
      remote = this.credentials.activeRemote;
    return new DriveClient(
      this.http,
      this.manager(accountRef),
      folderId ?? (remote?.accountRef === accountRef ? remote.folderId : ""),
      c.accountId,
      isIgnored,
    );
  }
  context(): string {
    if (!this.credentials.accounts.length)
      return `${this.state.state.deviceId}:unconfigured`;
    const c = this.credentials.credentials;
    const previous = `${this.state.state.deviceId}:${c.accountId}:${c.folderId}`;
    return this.localFolder === ROOT
      ? previous
      : `${previous}:local:${encodeURIComponent(this.localFolder)}`;
  }
  get localFolder(): string {
    return this.state.state.activeLocalFolder ?? ROOT;
  }
  get localFolders(): string[] {
    return this.state.state.localFolders ?? [ROOT];
  }
  get privateDirectory(): string {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/private`;
  }
  async saveIgnorePatterns(text: string): Promise<void> {
    this.ensureIdle();
    const patterns = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    new IgnoreRules(patterns);
    this.state.state.ignorePatterns = patterns;
    await this.state.save();
    this.invalidateReviews();
  }
  async selectLocalFolder(folder: string): Promise<void> {
    this.ensureIdle();
    if (!this.localFolders.includes(folder))
      throw new Error("Local folder is no longer configured");
    if (folder === this.localFolder) return;
    this.state.state.activeLocalFolder = folder;
    await this.state.save();
    this.invalidateReviews();
  }
  async addLocalFolder(path: string): Promise<void> {
    this.ensureIdle();
    const folder = localRoot(path.trim());
    const guard = await desktopGuard(this.app.vault, folder);
    new VaultBackend(this.app.vault, guard, folder, this.privateDirectory);
    await guard(folder);
    const stat = await this.app.vault.adapter.stat(folder);
    if (stat && stat.type !== "folder")
      throw new Error("The selected path is a file, not a folder");
    if (this.localFolders.includes(folder))
      throw new Error("This local folder is already configured");
    this.state.state.localFolders = [...this.localFolders, folder];
    this.state.state.activeLocalFolder = folder;
    await this.state.save();
    this.invalidateReviews();
  }
  async removeLocalFolder(folder: string): Promise<void> {
    this.ensureIdle();
    if (this.localFolders.length < 2)
      throw new Error("Keep at least one local folder");
    this.state.state.localFolders = this.localFolders.filter(
      (item) => item !== folder,
    );
    if (this.localFolder === folder)
      this.state.state.activeLocalFolder = this.localFolders[0]!;
    await this.state.save();
    this.invalidateReviews();
  }
  async selectRemote(id: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    if (this.credentials.activeRemote?.id === id) return;
    await this.credentials.selectRemote(id);
    this.invalidateReviews();
  }
  async renameRemote(id: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    const remote = this.credentials.remotes.find((r) => r.id === id);
    if (!remote) throw new Error("Remote profile no longer exists");
    const input = await form(this.app, "Rename remote", [
      { key: "name", label: "Remote name", value: remote.name },
    ]);
    if (input) {
      await this.credentials.renameRemote(id, input.name!.trim());
      this.invalidateReviews();
    }
  }
  async removeRemote(id: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    const remote = this.credentials.remotes.find((r) => r.id === id);
    if (!remote) return;
    if (
      await confirm(
        this.app,
        "Remove remote",
        `Remove “${remote.name}” from this device? Local and Drive files, baselines and unresolved history are kept.`,
        true,
      )
    ) {
      await this.credentials.removeRemote(id);
      this.invalidateReviews();
    }
  }
  async disconnectAccounts(): Promise<void> {
    this.ensureIdle();
    await this.credentials.disconnect();
    this.clearAuth();
    this.invalidateReviews();
  }
  async removeAccount(ref: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    const account = this.credentials.account(ref),
      names = this.credentials.remotes
        .filter((r) => r.accountRef === ref)
        .map((r) => r.name);
    if (
      await confirm(
        this.app,
        "Remove Google account",
        `Disconnect ${account.accountEmail} on this device and remove its ${names.length} remote profile(s)${names.length ? `: ${names.join(", ")}` : ""}? Files, baselines and unresolved history are kept.`,
        true,
      )
    ) {
      await this.credentials.removeAccount(ref);
      this.clearAuth();
      this.invalidateReviews();
    }
  }
  async refreshAccount(ref: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    await this.manager(ref).token(true);
    const user = await this.drive(ref).account();
    await this.credentials.update((next) => {
      const account = next.accounts.find((a) => a.id === ref)!;
      account.credentials.accountEmail = user.email;
      account.credentials.photoUrl = user.photoUrl;
      account.credentials.displayName = user.displayName;
    });
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
      c.photoUrl = account.photoUrl;
      c.displayName = account.displayName;
      if (c.folderId) {
        const folder = await drive.validateFolder();
        c.folderName = folder.name;
      }
    } finally {
      auth.lock();
    }
  }
  async connect(accountRef?: string): Promise<void> {
    this.ensureIdle();
    const existing = !!this.credentials.envelope;
    if (existing) await this.unlock();
    this.ensureIdle();
    if (!Platform.isDesktopApp)
      throw new Error(
        "Connect on Ubuntu, then import the encrypted bundle on Android",
      );
    if (
      !(await confirm(this.app, "Google Drive permission", (container) => {
        container.createEl("p", {
          text: "Remote Sync requires full drive access but confines its file operations to your selected folder.\nContinue to Google consent?",
          cls: "remote-sync-permission-copy",
        });
      }))
    )
      return;
    const input = await form(
      this.app,
      "Connect on Ubuntu",
      [
        {
          key: "clientId",
          label: "Desktop OAuth client ID",
          value: accountRef
            ? this.credentials.account(accountRef).clientId
            : "",
        },
        {
          key: "clientSecret",
          label: "Desktop OAuth client secret",
          secret: true,
        },
        ...(!existing
          ? [
              {
                key: "passphrase",
                label: "New encryption passphrase (12+ characters)",
                secret: true,
              },
              { key: "repeat", label: "Repeat passphrase", secret: true },
            ]
          : []),
      ],
      "Create a Desktop app OAuth client in Google Cloud. Values stay in memory until encrypted.",
    );
    if (!input) return;
    try {
      if (
        !existing &&
        (input.passphrase !== input.repeat || input.passphrase!.length < 12)
      )
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
      if (
        accountRef &&
        c.accountId !== this.credentials.account(accountRef).accountId
      )
        throw new Error("Sign in to the same Google account when reconnecting");
      if (existing) await this.credentials.addAccount(c);
      else await this.credentials.install(c, input.passphrase!);
      this.clearAuth();
      this.invalidateReviews();
      notify(
        "Remote Sync: account saved. Add a remote folder, then export it for Android.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async importCredentials(): Promise<void> {
    const raw = await pickFile();
    if (!raw) return;
    this.ensureIdle();
    const existing = !!this.credentials.envelope;
    if (existing) {
      await this.unlock();
      this.ensureIdle();
      if (
        !(await confirm(
          this.app,
          "Import remote",
          "Add the imported remote and its account to this device? An existing grant for the same account is updated; other accounts and remotes are kept.",
        ))
      )
        return;
    }
    const input = await form(
      this.app,
      "Import Encrypted Credentials",
      [
        { key: "passphrase", label: "Export passphrase", secret: true },
        ...(!existing
          ? [
              {
                key: "local",
                label: "Local encryption passphrase (12+ characters)",
                secret: true,
              },
              { key: "repeat", label: "Repeat local passphrase", secret: true },
            ]
          : []),
      ],
      "Import transfers no baseline or history. Token refresh and selected-folder access are validated before storage.",
    );
    if (!input) return;
    try {
      if (!existing && input.local !== input.repeat)
        throw new Error("Local passphrases do not match");
      await this.credentials.import(
        raw,
        input.passphrase!,
        (c) => this.validateCandidate(c),
        input.local!,
      );
      this.clearAuth();
      this.invalidateReviews();
      notify(
        "Remote Sync: imported and validated. Select a local folder before your first manual scan.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async exportCredentials(remoteId?: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    const remote = this.credentials.remotes.find(
      (r) => r.id === (remoteId ?? this.credentials.activeRemote?.id),
    );
    if (!remote) throw new Error("Select a remote before exporting");
    await this.refreshAccount(remote.accountRef);
    await this.drive(remote.accountRef, remote.folderId).validateFolder();
    const envelope = await this.credentials.export(remote.id);
    this.ensureIdle();
    downloadFile(
      "obsidian-remote-sync-credentials.json",
      JSON.stringify(envelope, null, 2),
    );
  }
  async changePassphrase(): Promise<void> {
    this.ensureIdle();
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
      this.clearAuth();
      notify(
        "Remote Sync: credentials re-encrypted. Previous export files still use their original passphrases.",
        "success",
      );
    } finally {
      for (const k of Object.keys(input)) input[k] = "";
    }
  }
  async chooseFolder(id: string, accountRef?: string): Promise<void> {
    this.ensureIdle();
    await this.unlock();
    this.ensureIdle();
    const ref = accountRef ?? this.credentials.configuration.activeAccountId;
    const drive = this.drive(ref),
      folder = await drive.validateFolder(id);
    await drive.account();
    if (
      this.credentials.remotes.some(
        (r) => r.accountRef === ref && r.folderId === id,
      )
    )
      throw new Error("This account and folder already have a remote profile");
    const input = await form(
      this.app,
      "Add remote",
      [{ key: "name", label: "Remote name", value: folder.name }],
      `Google Drive folder: ${folder.name}. Each local and remote folder combination has its own baseline.`,
    );
    if (!input) return;
    await this.credentials.addRemote(ref, id, folder.name, input.name!.trim());
    this.invalidateReviews();
  }
  async scan(onStatus?: (message: string) => void): Promise<Review> {
    if (this.scanBusy || this.executor?.busy)
      throw new Error("Scan or Apply already active");
    this.scanBusy = true;
    try {
      onStatus?.("Unlocking credentials…");
      await this.unlock();
      const c = this.credentials.credentials;
      const profile = { ...this.credentials.activeRemote! },
        selectionVersion = this.selectionVersion,
        context = this.context(),
        localFolder = this.localFolder;
      if (!c.folderId)
        throw new Error("Select a remote folder in Remote Sync settings");
      const ignoreRules = new IgnoreRules(this.state.state.ignorePatterns);
      const isIgnored = (path: string) =>
        ignoreRules.matches(
          localFolder && path ? `${localFolder}/${path}` : localFolder || path,
        );
      const localBackend = new VaultBackend(
          this.app.vault,
          await desktopGuard(this.app.vault, localFolder),
          localFolder,
          this.privateDirectory,
          isIgnored,
        ),
        remoteBackend = this.drive(
          profile.accountRef,
          profile.folderId,
          isIgnored,
        );
      // A missing local root must fail before any authentication/network work.
      await localBackend.validateRoot();
      onStatus?.("Checking local files and Google Drive…");
      const [local, remote] = await Promise.all([
        localBackend.scan(),
        remoteBackend.scan(),
      ]);
      const md5Paths = legacyHashPaths(
        local,
        remote,
        this.state.state.baselines[context] ?? {},
      );
      if (md5Paths.length) {
        // Old MD5-only remotes/baselines need the compatibility digest for
        // equality and portable rename matching. Modern trees avoid it entirely.
        onStatus?.("Checking legacy content checksums…");
        const legacy = await localBackend.scan(md5Paths, {
          includeMd5: true,
        });
        for (const path of md5Paths)
          if (!sameVersion(local.files[path], legacy.files[path]))
            throw new Error("Local files changed during scan. Scan again.");
        Object.assign(local.files, legacy.files);
        local.blocked = [...new Set([...local.blocked, ...legacy.blocked])];
      }
      if (
        context !== this.context() ||
        selectionVersion !== this.selectionVersion ||
        profile.id !== this.credentials.activeRemote?.id
      )
        throw new Error("Remote changed during scan. Scan again.");
      const identity = remoteBackend.accountInformation,
        saved = this.credentials.account(profile.accountRef);
      if (
        identity &&
        (identity.photoUrl !== saved.photoUrl ||
          identity.displayName !== saved.displayName ||
          identity.email !== saved.accountEmail)
      )
        await this.credentials.update((next) => {
          const account = next.accounts.find(
            (a) => a.id === profile.accountRef,
          )!;
          account.credentials.accountEmail = identity.email;
          account.credentials.photoUrl = identity.photoUrl;
          account.credentials.displayName = identity.displayName;
        });
      onStatus?.("Comparing file contents…");
      const changes = reconcile(
        local,
        remote,
        Object.fromEntries(
          Object.entries(this.state.state.baselines[context] ?? {}).filter(
            ([, baseline]) =>
              ![
                baseline.path,
                baseline.local?.path,
                baseline.remote?.path,
              ].some((path) => path !== undefined && isIgnored(path)),
          ),
        ),
      ).filter(
        (change) =>
          ![change.path, change.localPath, change.remotePath].some(isIgnored),
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
        () =>
          selectionVersion === this.selectionVersion &&
          profile.id === this.credentials.activeRemote?.id,
        isIgnored,
      );
      return {
        local,
        remote,
        changes,
        context,
        profileId: profile.id,
        remoteName: profile.name,
        localFolder,
        selectionVersion,
      };
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
