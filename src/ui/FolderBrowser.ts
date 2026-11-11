import { App, Modal, Setting } from "obsidian";
import type RemoteSyncPlugin from "../main";
import { confirm, form } from "./Dialogs";
import { pageHeader } from "./PageHeader";

export class FolderBrowser extends Modal {
  private stack: { id: string; name: string }[] = [
    { id: "root", name: "My Drive" },
  ];
  constructor(
    app: App,
    private plugin: RemoteSyncPlugin,
    private refresh: () => void | Promise<void>,
    private accountRef?: string,
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
    const folders = await this.plugin
      .drive(this.accountRef)
      .folders(current.id);
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
              await this.plugin.chooseFolder(current.id, this.accountRef);
              await this.refresh();
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
            .drive(this.accountRef)
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
