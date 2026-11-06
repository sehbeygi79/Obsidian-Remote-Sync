/** Shared branding for Remote Sync settings and dialogs. */
export function pageHeader(parent: HTMLElement, title: string): HTMLElement {
  parent.addClass("remote-sync-page");
  const header = parent.createDiv({ cls: "remote-sync-page-header" });
  header.createEl("div", { text: "REMOTE SYNC", cls: "remote-sync-eyebrow" });
  header.createEl("h2", { text: title });
  return header;
}
