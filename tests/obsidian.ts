import { vi } from "vitest";
import { UiElement, uiDocument } from "./ui-host";
export function setIcon(element: UiElement, icon: string): void {
  element.setAttribute("data-icon", icon);
}
export const Platform = {
  isDesktopApp: false,
  isAndroidApp: true,
  isMobile: true,
};
export class TFile {
  constructor(public path: string) {}
}
export class FileSystemAdapter {
  getBasePath(): string {
    return "/tmp";
  }
}
export class Notice {
  static instances: Notice[] = [];
  containerEl: UiElement;
  messageEl: UiElement;
  constructor(
    message: string,
    public duration?: number,
  ) {
    this.containerEl = uiDocument.body.createDiv({ cls: "notice" });
    this.messageEl = this.containerEl.createDiv({ cls: "notice-message" });
    this.messageEl.textContent = message;
    Notice.instances.push(this);
  }
  hide(): void {
    this.containerEl.remove();
  }
}
export class Plugin {
  app: unknown;
  manifest = {
    id: "obsidian-remote-sync",
    name: "Remote Sync",
    version: "1.4.0",
    dir: ".obsidian/plugins/obsidian-remote-sync",
  };
  registrations: unknown[] = [];
  addRibbonIcon(...args: unknown[]): void {
    this.registrations.push(args);
  }
  addCommand(...args: unknown[]): void {
    this.registrations.push(args);
  }
  addSettingTab(...args: unknown[]): void {
    this.registrations.push(args);
  }
}
export { Modal, Setting } from "./ui-host";
export class PluginSettingTab {
  containerEl = new UiElement();
  constructor(
    public app: unknown,
    _plugin: unknown,
  ) {}
}
export const requestUrl = vi.fn();
