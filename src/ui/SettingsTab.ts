import { App, PluginSettingTab, Setting } from "obsidian";
import type RemoteSyncPlugin from "../main";
import { confirm, downloadFile, form } from "./Dialogs";
import { FolderBrowser } from "./FolderBrowser";
import { HistoryModal } from "./HistoryModal";
import { notify } from "./Notifications";
import { pageHeader } from "./PageHeader";
import { photoSelector } from "./PhotoSelector";
import { timeRemaining } from "./TokenStatus";
import { syncCommits } from "./HistoryGroups";
import {
  concurrentTransfers,
  MAX_CONCURRENT_TRANSFERS,
  TRANSFER_CHUNK_SIZES,
  transferChunkSize,
} from "../sync/TransferSettings";
export class RemoteSyncSettings extends PluginSettingTab {
  private countdownTimer?: number;
  private viewedAccountRef?: string;
  hide(): void {
    if (this.countdownTimer !== undefined)
      window.clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }
  constructor(
    app: App,
    private plugin: RemoteSyncPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
    this.hide();
    const countdowns: (() => void)[] = [];
    const host = this.containerEl;
    host.empty();
    // Obsidian sizes and centers the host pane with its own responsive padding.
    // Constrain only our content, never the pane that owns that padding.
    const el = host.createDiv({ cls: "remote-sync-settings" });
    pageHeader(el, "Settings");
    el.createEl("p", {
      text: "Connect your account, choose your folders, and sync when you’re ready.",
      cls: "remote-sync-page-intro",
    });
    const section = (title: string, description: string, collapsed = false) => {
      const card = el.createEl(collapsed ? "details" : "section", {
        cls: "remote-sync-settings-card",
      });
      card.createEl(collapsed ? "summary" : "h3", { text: title });
      const body = card.createDiv({ cls: "remote-sync-settings-card-body" });
      if (description)
        body.createEl("p", {
          text: description,
          cls: "remote-sync-settings-caption",
        });
      return body;
    };
    const account = section("Google account", "");
    const folders = section(
      "Remote",
      "Choose one local folder and one remote for each manual sync.",
    );
    const configurations = section(
      "Configurations",
      "Set transfer, history retention and ignored path preferences.",
      true,
    );
    const credentialTools = section(
      "Credentials & device transfer",
      "Credentials are encrypted on this device. Unlock once per session.",
      true,
    );
    const history = section(
      "Activity & history",
      "Review each sync commit and its individual file operations.",
      true,
    );
    const advanced = section(
      "Advanced & recovery",
      "Recovery tools affect this device’s metadata. Review each confirmation before continuing.",
      true,
    );
    const run = (task: () => Promise<unknown>) =>
      this.plugin.run(async () => {
        const scroll = host.scrollTop;
        await task();
        this.display();
        host.scrollTop = scroll;
      });
    const button = (
      parent: HTMLElement,
      name: string,
      label: string,
      task: () => Promise<unknown>,
      description = "",
      warning = false,
      disabled = false,
    ) =>
      new Setting(parent)
        .setName(name)
        .setDesc(description)
        .addButton((b) => {
          b.setButtonText(label)
            .setDisabled(disabled)
            .onClick(() => run(task));
          if (warning) b.setWarning();
        });
    const credentials = this.plugin.credentials;
    const unlocked = credentials.unlocked;
    const accounts = unlocked ? credentials.accounts : [];
    const profiles = unlocked ? credentials.remotes : [];
    const viewedAccount =
      accounts.find((a) => a.id === this.viewedAccountRef) ??
      accounts.find(
        (a) => a.id === credentials.configuration.activeAccountId,
      ) ??
      accounts[0];
    const newRemoteAccountRef = viewedAccount?.id;
    if (viewedAccount) {
      const selector = photoSelector(
        account,
        accounts.map((saved) => ({
          id: saved.id,
          title:
            saved.credentials.displayName || saved.credentials.accountEmail,
          description: saved.credentials.accountEmail,
          account: saved.credentials,
        })),
        viewedAccount.id,
        "Google account",
        (id) => {
          this.viewedAccountRef = id;
          this.display();
        },
        false,
        {
          onAuthorize: (id) => run(() => this.plugin.connect(id)),
          onRemove: (id) => run(() => this.plugin.removeAccount(id)),
          onAdd: () => run(() => this.plugin.connect()),
          addLabel: "Add account",
        },
      );
      const updateAccountRows = () => {
        for (const saved of accounts) {
          const status = this.plugin.tokenStatus(saved.id);
          const consent = status.needsReconnect
            ? "Authorization required"
            : status.refreshExpiresAt
              ? `Consent expires · ${timeRemaining(status.refreshExpiresAt)}`
              : "Consent expiry not reported";
          selector.setDescription(
            saved.id,
            `${saved.credentials.accountEmail} · ${consent}`,
          );
        }
      };
      updateAccountRows();
      countdowns.push(updateAccountRows);
      account.createEl("p", {
        text: "Access tokens renew automatically. This countdown shows the Google consent expiry when provided.",
        cls: "remote-sync-settings-caption",
      });
    } else {
      photoSelector(
        account,
        [
          {
            id: "__no_account__",
            title: unlocked
              ? "No Google accounts"
              : credentials.envelope
                ? "Accounts locked"
                : "Connect Google Drive",
            description: "",
            icon: "user-round",
          },
        ],
        "__no_account__",
        "Google account",
        () => {},
        false,
        {
          onAdd: () => run(() => this.plugin.connect()),
          addLabel: "Add account",
        },
      );
    }
    if (unlocked) {
      // Lock checks plugin.working itself; wrapping it in run() would block it.
      new Setting(account)
        .setName("Session")
        .setDesc("Lock credentials when you’re finished.")
        .addButton((b) =>
          b.setButtonText("Lock").onClick(() => {
            this.plugin.lock();
            this.display();
          }),
        );
    } else if (credentials.envelope) {
      button(account, "Session", "Unlock", () => this.plugin.unlock());
    }
    photoSelector(
      folders,
      this.plugin.localFolders.map((path) => ({
        id: path,
        title: path ? `${path}/` : "Entire vault (./)",
        description: "Local folder",
        icon: path ? "folder" : "vault",
      })),
      this.plugin.localFolder,
      "Local folder",
      (path) => run(() => this.plugin.selectLocalFolder(path)),
      false,
      {
        heading: "Local Folder",
        addLabel: "Add local",
        onAdd: () =>
          run(async () => {
            const input = await form(
              this.app,
              "Add local folder",
              [
                {
                  key: "path",
                  label: "Vault-relative folder path",
                  value: "./",
                },
              ],
              "Enter a vault-relative folder path, or ./ for the entire vault.",
            );
            if (input) await this.plugin.addLocalFolder(input.path!);
          }),
        onRemove: (path) =>
          run(async () => {
            if (
              await confirm(
                this.app,
                "Remove local folder",
                `Remove ${path ? `${path}/` : "the entire vault"} from the saved choices? Files and sync history are kept.`,
              )
            )
              await this.plugin.removeLocalFolder(path);
          }),
        canRemove: () => this.plugin.localFolders.length > 1,
      },
    );
    if (profiles.length) {
      photoSelector(
        folders,
        profiles.map((profile) => ({
          id: profile.id,
          title: profile.name,
          description: `${credentials.account(profile.accountRef).accountEmail} · ${profile.folderName}`,
          account: credentials.account(profile.accountRef),
        })),
        credentials.activeRemote?.id ?? profiles[0]!.id,
        "Remote profile",
        (id) => {
          run(async () => {
            await this.plugin.selectRemote(id);
            this.viewedAccountRef =
              this.plugin.credentials.activeRemote?.accountRef;
          });
        },
        false,
        {
          heading: "Remote Folder",
          addLabel: "Add remote",
          onAdd: () =>
            new FolderBrowser(
              this.app,
              this.plugin,
              () => this.display(),
              newRemoteAccountRef,
            ).open(),
          onRename: (id) => run(() => this.plugin.renameRemote(id)),
          onRemove: (id) => run(() => this.plugin.removeRemote(id)),
        },
      );
    } else {
      photoSelector(
        folders,
        [
          {
            id: "__no_remote__",
            title: "No remote selected",
            description: "Browse Google Drive folders to add one",
            icon: "cloud",
          },
        ],
        "__no_remote__",
        "Remote profile",
        () => {},
        false,
        {
          heading: "Remote Folder",
          addLabel: "Add remote",
          onAdd: () =>
            new FolderBrowser(
              this.app,
              this.plugin,
              () => this.display(),
              newRemoteAccountRef,
            ).open(),
        },
      );
    }
    folders.createEl("p", {
      text: "Each local folder and remote pair has its own sync history. Changes downloaded into a shared folder are visible to other remotes.",
      cls: "remote-sync-settings-caption",
    });
    button(
      folders,
      "Check connection",
      "Validate",
      async () => {
        await this.plugin.unlock();
        if (!credentials.activeRemote)
          throw new Error("Add and select a remote first");
        await this.plugin.refreshAccount(credentials.activeRemote.accountRef);
        const drive = this.plugin.drive();
        await drive.validateFolder();
        notify(
          "Remote Sync: account, refresh grant and folder access verified.",
          "success",
        );
      },
      "Verify your account, folder and refresh grant.",
    );
    new Setting(configurations)
      .setName("Maximum simultaneous transfers")
      .setDesc(
        "Combined uploads and downloads on this device. Applies to the next Apply. Higher limits use more memory; choose 1 for sequential transfers.",
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute(
          "aria-label",
          "Maximum simultaneous transfers",
        );
        for (let count = 1; count <= MAX_CONCURRENT_TRANSFERS; count++)
          dropdown.addOption(String(count), String(count));
        dropdown
          .setValue(
            String(
              concurrentTransfers(
                this.plugin.state.state.maxConcurrentTransfers,
              ),
            ),
          )
          .onChange((value) =>
            run(async () => {
              const previous = this.plugin.state.state.maxConcurrentTransfers;
              this.plugin.state.state.maxConcurrentTransfers =
                concurrentTransfers(Number(value));
              try {
                await this.plugin.state.save();
              } catch (error) {
                this.plugin.state.state.maxConcurrentTransfers = previous;
                throw error;
              }
            }),
          );
      });
    new Setting(configurations)
      .setName("Transfer chunk size")
      .setDesc(
        "Smaller chunks give more frequent progress updates but require more requests. Applies to the next sync on this device.",
      )
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", "Transfer chunk size");
        for (const size of TRANSFER_CHUNK_SIZES)
          dropdown.addOption(
            String(size),
            size < 1024 * 1024
              ? `${size / 1024} KiB`
              : `${size / (1024 * 1024)} MiB`,
          );
        dropdown
          .setValue(
            String(
              transferChunkSize(this.plugin.state.state.transferChunkSize),
            ),
          )
          .onChange((value) =>
            run(async () => {
              const previous = this.plugin.state.state.transferChunkSize;
              this.plugin.state.state.transferChunkSize = transferChunkSize(
                Number(value),
              );
              try {
                await this.plugin.state.save();
              } catch (error) {
                this.plugin.state.state.transferChunkSize = previous;
                throw error;
              }
            }),
          );
      });
    const ignore = configurations.createDiv({
      cls: "remote-sync-ignore-settings",
    });
    ignore.createEl("h4", { text: "Ignored files and folders" });
    ignore.createEl("p", {
      text: "One entry per line, relative to the vault. Folders include all their contents. Use * for names, ** for nested folders, or # for comments. Applies to every local folder and remote on this device.",
      cls: "remote-sync-settings-caption",
    });
    const ignoreInput = ignore.createEl("textarea", {
      cls: "remote-sync-ignore-input",
      attr: {
        "aria-label": "Ignored files and folders",
        rows: "5",
        spellcheck: "false",
        placeholder: ".obsidian/\nmaterials/private/\n*.tmp\n**/*.bak",
      },
    });
    ignoreInput.value = (this.plugin.state.state.ignorePatterns ?? []).join(
      "\n",
    );
    new Setting(ignore)
      .setDesc(
        "Ignored paths are omitted from scans and Review Status. Existing files and sync history are kept. Save, then scan again.",
      )
      .addButton((button) =>
        button.setButtonText("Save ignore list").onClick(() =>
          run(async () => {
            await this.plugin.saveIgnorePatterns(ignoreInput.value);
            notify(
              "Remote Sync: ignore list saved. Scan again to refresh status.",
              "success",
            );
          }),
        ),
      );
    new Setting(credentialTools)
      .setName("Move credentials between devices")
      .setDesc(
        "Export only the selected remote and its account. Transfer the encrypted file separately from its passphrase.",
      )
      .addButton((b) =>
        b
          .setButtonText("Import")
          .onClick(() => run(() => this.plugin.importCredentials())),
      )
      .addButton((b) =>
        b
          .setButtonText("Export")
          .setDisabled(!credentials.envelope)
          .onClick(() => run(() => this.plugin.exportCredentials())),
      );
    button(
      credentialTools,
      "Encryption passphrase",
      "Change",
      () => this.plugin.changePassphrase(),
      "Existing exports keep their original passphrase.",
      false,
      !credentials.envelope,
    );
    button(
      credentialTools,
      "Disconnect this device",
      "Disconnect",
      async () => {
        if (
          await confirm(
            this.app,
            "Disconnect",
            "Erase all Google accounts and remote profiles stored on this device? Other devices remain connected. Revoke the Google grant separately in your Google account if desired.",
            true,
          )
        ) {
          await this.plugin.disconnectAccounts();
        }
      },
      "Removes local credentials. Remote files stay in place.",
      true,
      !credentials.envelope,
    );
    credentialTools.createEl("p", {
      text: "AES-256-GCM · PBKDF2-SHA256 · 600,000 iterations",
      cls: "remote-sync-settings-footnote",
    });
    const commits = syncCommits(
      this.plugin.state.state.operations,
      this.plugin.state.state.journal,
    );
    new Setting(history)
      .setName("Activity history")
      .setDesc(
        `${commits.length} sync commits · ${commits.reduce((total, commit) => total + commit.operations.length, 0)} file operations`,
      )
      .addButton((b) =>
        b
          .setButtonText("View history")
          .onClick(() => new HistoryModal(this.app, this.plugin.state).open()),
      );
    let retention = String(this.plugin.state.state.retentionDays);
    new Setting(configurations)
      .setName("Keep history for")
      .setDesc("Days · 1–3650. Baselines and unresolved entries are retained.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "3650";
        t.inputEl.setAttribute("aria-label", "History retention in days");
        t.setValue(retention).onChange((value) => {
          retention = value;
        });
      })
      .addButton((b) =>
        b.setButtonText("Save").onClick(() =>
          run(async () => {
            const days = Number(retention);
            if (!Number.isInteger(days) || days < 1 || days > 3650)
              throw new Error(
                "Enter a whole number of days between 1 and 3650",
              );
            this.plugin.state.state.retentionDays = days;
            this.plugin.state.prune();
            await this.plugin.state.save();
          }),
        ),
      );
    button(
      history,
      "Clear diagnostic history",
      "Clear",
      async () => {
        if (
          await confirm(
            this.app,
            "Clear history",
            "Delete observations and operation history? Baselines and unresolved journal entries remain.",
            true,
          )
        ) {
          this.plugin.state.state.operations = [];
          this.plugin.state.state.observations = [];
          await this.plugin.state.save();
        }
      },
      "Keeps confirmed baselines and unresolved entries.",
      true,
    );
    button(advanced, "Reset synchronization baseline", "Reset", async () => {
      await this.plugin.unlock();
      if (
        await confirm(
          this.app,
          "Reset baseline",
          "Reset only this device/account/folder baseline? Files are untouched. The next scan is a first sync with no inferred deletions.",
          true,
        )
      ) {
        delete this.plugin.state.state.baselines[this.plugin.context()];
        await this.plugin.state.save();
        this.plugin.executor = null;
      }
    });
    button(advanced, "Rebuild observed metadata", "Scan", async () => {
      await this.plugin.scan();
      notify(
        "Remote Sync: observations rebuilt; baseline unchanged.",
        "success",
      );
    });
    button(advanced, "Acknowledge unresolved journal", "Review", async () => {
      await this.plugin.unlock();
      const context = this.plugin.context();
      if (
        !this.plugin.state.state.observations.some(
          (o) =>
            o.context === context &&
            o.at >
              Math.max(
                0,
                ...this.plugin.state.state.journal
                  .filter((j) => j.context === context)
                  .map((j) => j.at),
              ),
        )
      )
        throw new Error("Run a fresh manual scan and inspect both sides first");
      if (
        await confirm(
          this.app,
          "Acknowledge interrupted operations",
          "Only clear the unresolved flags after inspecting history and both sides. This does not resume transfers or advance the baseline.",
        )
      ) {
        this.plugin.state.state.journal =
          this.plugin.state.state.journal.filter((j) => j.context !== context);
        await this.plugin.state.save();
      }
    });
    button(
      advanced,
      "Export redacted diagnostic report",
      "Export",
      async () => {
        const state = this.plugin.state.state;
        // Aggregate report: exclude credentials, account IDs, paths, file contents and raw responses.
        downloadFile(
          "obsidian-remote-sync-diagnostics.json",
          JSON.stringify(
            {
              plugin: "obsidian-remote-sync",
              version: this.plugin.manifest.version,
              schema: state.schema,
              observations: state.observations.length,
              baselines: Object.values(state.baselines).map(
                (b) => Object.keys(b).length,
              ),
              operations: state.operations.map((o) => ({
                at: o.at,
                action: o.action,
                status: o.status,
                reason: o.reason,
              })),
              unresolved: state.journal.length,
            },
            null,
            2,
          ),
        );
      },
    );
    if (countdowns.length && typeof window !== "undefined") {
      this.countdownTimer = window.setInterval(() => {
        if (!host.isConnected) {
          this.hide();
          return;
        }
        for (const update of countdowns) update();
      }, 60_000);
      this.plugin.registerInterval?.(this.countdownTimer);
    }
    el.createEl("p", {
      text: `Remote Sync · Version ${this.plugin.manifest.version}`,
      cls: "remote-sync-settings-footnote",
    });
  }
}
