import { photoUrl, type Credentials } from "../auth/CredentialEncryption";

export function accountAvatar(parent: HTMLElement, account: Credentials): void {
  const avatar = parent.createDiv({
    cls: "remote-sync-avatar",
    attr: { "aria-hidden": "true" },
  });
  avatar.createEl("span", {
    text: (account.displayName || account.accountEmail || "G")
      .slice(0, 1)
      .toLocaleUpperCase(),
  });
  const url = photoUrl(account.photoUrl);
  if (!url) return;
  const image = avatar.createEl("img", {
    attr: {
      src: url,
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    },
  });
  image.addEventListener("error", () => image.remove(), { once: true });
}
