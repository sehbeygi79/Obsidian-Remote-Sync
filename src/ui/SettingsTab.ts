import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type RemoteSyncPlugin from "../main";
import { confirm, downloadFile, form } from "./Dialogs";
import { HistoryModal } from "./HistoryModal";
import { notify } from "./Notifications";
import { pageHeader } from "./PageHeader";
import { syncCommits } from "./HistoryGroups";
class FolderBrowser extends Modal {
  private stack: { id: string; name: string }[] = [
    { id: "root", name: "My Drive" },
  ];
  constructor(
    app: App,
    private plugin: RemoteSyncPlugin,
    private refresh: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.plugin.run(async () => {
      await this.plugin.unlock();
      await this.render();
    });
  }
  private async render(): Promise<void> {
    const current = this.stack.at(-1)!;
    this.contentEl.empty();
    pageHeader(this.contentEl, "Select remote folder");
    this.contentEl.createEl("p", {
      text: this.stack.map((f) => f.name).join(" / "),
    });
    const folders = await this.plugin.drive().folders(current.id);
    const nav = new Setting(this.contentEl);
    if (this.stack.length > 1)
      nav.addButton((b) =>
        b.setButtonText("Up").onClick(() =>
          this.plugin.run(async () => {
            this.stack.pop();
            await this.render();
          }),
        ),
      );
    if (current.id !== "root")
      nav.addButton((b) =>
        b
          .setButtonText("Use this folder")
          .setCta()
          .onClick(() =>
            this.plugin.run(async () => {
              await this.plugin.chooseFolder(current.id);
              this.refresh();
              this.close();
            }),
          ),
      );
    nav.addButton((b) =>
      b.setButtonText("Create folder here").onClick(() =>
        this.plugin.run(async () => {
          const input = await form(this.app, "Create Drive folder", [
            { key: "name", label: "Folder name" },
          ]);
          if (!input) return;
          if (
            !(await confirm(
              this.app,
              "Create folder",
              `Create ${input.name} in ${current.name}?`,
            ))
          )
            return;
          const folder = await this.plugin
            .drive()
            .createFolder(input.name!, current.id);
          this.stack.push(folder);
          await this.render();
        }),
      ),
    );
    for (const folder of folders)
      new Setting(this.contentEl)
        .setName(folder.name)
        .setDesc(folder.id)
        .addButton((b) =>
          b.setButtonText("Open").onClick(() =>
            this.plugin.run(async () => {
              this.stack.push(folder);
              await this.render();
            }),
          ),
        );
    if (!folders.length)
      this.contentEl.createEl("p", { text: "No owned subfolders." });
  }
}
export class RemoteSyncSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RemoteSyncPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
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
      "Sync folders",
      "Only materials/ is synchronized. All synchronization starts with a manual review.",
    );
    const credentialTools = section(
      "Credentials & device transfer",
      "Credentials are encrypted on this device. Unlock once per session.",
      true,
    );
    const history = section(
      "Activity & history",
      "Review each sync commit and its individual file operations.",
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
    const connected = credentials.unlocked;
    const status = account.createDiv({ cls: "remote-sync-account-status" });
    const identity = status.createDiv();
    identity.createEl("strong", {
      text: connected
        ? credentials.credentials.accountEmail
        : credentials.envelope
          ? "Your account is saved"
          : "Connect Google Drive",
    });
    identity.createEl("p", {
      text: connected
        ? "Ready for manual synchronization"
        : credentials.envelope
          ? "Unlock to view your account and selected folder"
          : "Connect on desktop or import credentials from another device.",
      cls: "remote-sync-settings-caption",
    });
    status.createEl("span", {
      text: connected
        ? "Unlocked"
        : credentials.envelope
          ? "Locked"
          : "Not connected",
      cls: `remote-sync-badge remote-sync-tone-${connected ? "equal" : credentials.envelope ? "deletion" : "neutral"}`,
    });
    if (connected) {
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
    } else {
      button(
        account,
        "Desktop connection",
        "Connect on Ubuntu",
        () => this.plugin.connect(),
        "Sign in using your Desktop OAuth client.",
      );
    }
    const paths = folders.createDiv({ cls: "remote-sync-settings-paths" });
    const local = paths.createDiv({ cls: "remote-sync-settings-path" });
    local.createEl("span", {
      text: "LOCAL FOLDER",
      cls: "remote-sync-settings-path-label",
    });
    local.createEl("strong", { text: "materials/" });
    local.createEl("p", {
      text: "Every regular file type, including subfolders.",
      cls: "remote-sync-settings-caption",
    });
    const remote = paths.createDiv({ cls: "remote-sync-settings-path" });
    remote.createEl("span", {
      text: "GOOGLE DRIVE",
      cls: "remote-sync-settings-path-label",
    });
    remote.createEl("strong", {
      text: connected
        ? credentials.credentials.folderName || "Choose a folder"
        : credentials.envelope
          ? "Unlock to view folder"
          : "Connect to choose a folder",
    });
    remote.createEl("p", {
      text: "An owned, writable My Drive folder.",
      cls: "remote-sync-settings-caption",
    });
    new Setting(folders)
      .setName("Remote folder")
      .addButton((b) =>
        b
          .setButtonText("Browse folders")
          .onClick(() =>
            new FolderBrowser(this.app, this.plugin, () =>
              this.display(),
            ).open(),
          ),
      )
      .addButton((b) =>
        b.setButtonText("Enter ID").onClick(() =>
          run(async () => {
            await this.plugin.unlock();
            const input = await form(this.app, "Select existing folder", [
              { key: "id", label: "Google Drive folder ID" },
            ]);
            if (input) await this.plugin.chooseFolder(input.id!.trim());
          }),
        ),
      );
    button(
      folders,
      "Check connection",
      "Validate",
      async () => {
        await this.plugin.unlock();
        const drive = this.plugin.drive();
        await drive.account();
        await drive.validateFolder();
        await this.plugin.manager().token(true);
        notify(
          "Remote Sync: account, refresh grant and folder access verified.",
          "success",
        );
      },
      "Verify your account, folder and refresh grant.",
    );
    if (connected && credentials.credentials.folderId) {
      const folderDetails = folders.createEl("details", {
        cls: "remote-sync-settings-details",
      });
      folderDetails.createEl("summary", { text: "Folder details" });
      new Setting(folderDetails)
        .setName("Folder ID")
        .setDesc(credentials.credentials.folderId)
        .addButton((b) =>
          b
            .setButtonText("Open Google Drive")
            .onClick(() =>
              window.open(
                `https://drive.google.com/drive/folders/${encodeURIComponent(credentials.credentials.folderId)}`,
              ),
            ),
        );
    }
    button(folders, "Local folder", "Create if missing", async () => {
      if (!(await this.app.vault.adapter.exists("materials"))) {
        if (
          await confirm(
            this.app,
            "Create local root",
            "Create materials/ in this vault?",
          )
        )
          await this.app.vault.createFolder("materials");
      } else notify("materials/ already exists");
    });
    new Setting(credentialTools)
      .setName("Move credentials between devices")
      .setDesc("Transfer the encrypted file separately from its passphrase.")
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
    if (credentials.envelope)
      button(
        credentialTools,
        "Desktop connection",
        "Reconnect",
        () => this.plugin.connect(),
        "Use a different account or renew authorization.",
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
            "Erase this device’s stored credentials? Other devices remain connected. Revoke the Google grant separately in your Google account if desired.",
            true,
          )
        ) {
          await credentials.disconnect();
          this.plugin.executor = null;
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
    new Setting(history)
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
    el.createEl("p", {
      text: `Remote Sync · Version ${this.plugin.manifest.version}`,
      cls: "remote-sync-settings-footnote",
    });
  }
}
