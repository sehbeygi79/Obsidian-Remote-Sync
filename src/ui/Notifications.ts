import { Notice } from "obsidian";

export type NotificationTone = "success" | "warning" | "error" | "info";
const TITLES: Record<NotificationTone, string> = {
  success: "Success",
  warning: "Warning",
  error: "Failed",
  info: "Information",
};
const notices = new Set<Notice>();
const regions = new Set<HTMLElement>();
let syncResultNotice: Notice | undefined;

/** Persistent, explicitly dismissible notices, scoped to this plugin. */
export function notify(
  message: string,
  tone: NotificationTone = "info",
): Notice {
  const notice = new Notice("", 0);
  const doc = notice.containerEl.ownerDocument;
  let region = doc.querySelector<HTMLElement>(".remote-sync-notices");
  if (!region) {
    region = doc.body.createDiv({
      cls: "remote-sync-notices",
      attr: { "aria-label": "Remote Sync notifications" },
    });
    regions.add(region);
  }
  const container = notice.containerEl;
  container.addClass("remote-sync-notice", `remote-sync-notice--${tone}`);
  container.setAttribute("role", tone === "error" ? "alert" : "status");
  region.appendChild(container);
  notices.add(notice);

  const content = notice.messageEl;
  content.empty();
  // Reading or selecting notice text must not trigger Obsidian's click-to-hide.
  content.addEventListener("click", (event) => event.stopPropagation());
  const body = content.createDiv({ cls: "remote-sync-notice-body" });
  body.createEl("strong", {
    text: `Remote Sync · ${TITLES[tone]}`,
    cls: "remote-sync-notice-title",
  });
  body.createEl("div", {
    text: message.replace(/^Remote Sync:\s*/u, ""),
    cls: "remote-sync-notice-text",
  });
  const dismiss = content.createEl("button", {
    text: "×",
    cls: "remote-sync-notice-dismiss",
    attr: {
      type: "button",
      "aria-label": "Dismiss notification",
      title: "Dismiss",
    },
  });
  dismiss.addEventListener("click", (event) => {
    event.stopPropagation();
    notices.delete(notice);
    notice.hide();
  });
  return notice;
}

/** Keep only the latest sync result visible while preserving other notices. */
export function notifySyncResult(
  message: string,
  tone: NotificationTone = "info",
): Notice {
  if (syncResultNotice) {
    notices.delete(syncResultNotice);
    syncResultNotice.hide();
  }
  syncResultNotice = notify(message, tone);
  return syncResultNotice;
}

export function dismissNotifications(): void {
  for (const notice of notices) notice.hide();
  notices.clear();
  for (const region of regions) region.remove();
  regions.clear();
  syncResultNotice = undefined;
}
