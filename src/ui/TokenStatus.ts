import type RemoteSyncPlugin from "../main";

export function timeRemaining(deadline: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (!seconds) return "Expired";
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days}d ${hours}h remaining`
    : hours
      ? `${hours}h ${minutes}m remaining`
      : minutes
        ? `${minutes}m ${seconds % 60}s remaining`
        : `${seconds}s remaining`;
}
export function tokenStatus(
  parent: HTMLElement,
  plugin: RemoteSyncPlugin,
  accountRef: string,
): () => void {
  const area = parent.createDiv({ cls: "remote-sync-token-status" });
  const access = area.createEl("p"),
    refresh = area.createEl("p");
  const update = () => {
    if (!plugin.credentials.unlocked) {
      access.textContent = "Credentials locked";
      refresh.textContent = "";
      return;
    }
    const status = plugin.tokenStatus(accountRef);
    access.textContent = `Access token · ${status.accessExpiresAt ? timeRemaining(status.accessExpiresAt) : "No cached access token"} · renews automatically when needed`;
    refresh.textContent = `Authorization · ${status.needsReconnect ? "Reconnect required" : status.refreshExpiresAt ? timeRemaining(status.refreshExpiresAt) : "Expiry not supplied by Google"}`;
    refresh.setAttribute(
      "data-expired",
      String(
        status.needsReconnect ||
          (!!status.refreshExpiresAt && status.refreshExpiresAt <= Date.now()),
      ),
    );
    if (status.refreshExpiresAt)
      refresh.title = `Google-reported refresh-token deadline: ${new Date(status.refreshExpiresAt).toLocaleString()}`;
  };
  update();
  return update;
}
