import { App, Modal, Setting } from "obsidian";
import { MAX_CREDENTIAL_FILE_SIZE } from "../auth/CredentialEncryption";
import { pageHeader } from "./PageHeader";
export interface SavedOAuthClient {
  accountRef: string;
  email: string;
  clientId: string;
}
export type OAuthClientChoice =
  { kind: "saved"; accountRef: string } | { kind: "new" } | null;

/** Offer saved encrypted OAuth clients without rendering their client secrets. */
export function chooseOAuthClient(
  app: App,
  clients: SavedOAuthClient[],
): Promise<OAuthClientChoice> {
  return new Promise((resolve) => {
    class OAuthClientPicker extends Modal {
      private choice: OAuthClientChoice = null;
      onOpen(): void {
        this.modalEl.addClass("remote-sync-dialog");
        pageHeader(this.contentEl, "Choose OAuth client");
        this.contentEl.createEl("p", {
          text: "Use an encrypted client already saved with an account, or enter a different client ID and secret.",
        });
        for (const client of clients)
          new Setting(this.contentEl)
            .setName(client.email)
            .setDesc(`Client ID · ${client.clientId}`)
            .addButton((button) =>
              button.setButtonText("Use saved client").onClick(() => {
                this.choice = { kind: "saved", accountRef: client.accountRef };
                this.close();
              }),
            );
        new Setting(this.contentEl)
          .setName("Different OAuth client")
          .setDesc(
            "Enter a client ID and secret. The secret is stored encrypted.",
          )
          .addButton((button) =>
            button.setButtonText("Enter new client").onClick(() => {
              this.choice = { kind: "new" };
              this.close();
            }),
          );
        new Setting(this.contentEl).addButton((button) =>
          button.setButtonText("Cancel").onClick(() => this.close()),
        );
      }
      onClose(): void {
        resolve(this.choice);
        this.contentEl.empty();
      }
    }
    new OAuthClientPicker(app).open();
  });
}

export function confirm(
  app: App,
  title: string,
  description: string | ((container: HTMLElement) => void),
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    class Confirm extends Modal {
      private accepted = false;
      onOpen(): void {
        this.modalEl.addClass("remote-sync-dialog");
        pageHeader(this.contentEl, title);
        if (typeof description === "string")
          this.contentEl.createEl("p", { text: description });
        else
          description(
            this.contentEl.createDiv({ cls: "remote-sync-confirm-body" }),
          );
        new Setting(this.contentEl)
          .addButton((b) =>
            b.setButtonText("Cancel").onClick(() => this.close()),
          )
          .addButton((b) => {
            b.setButtonText("Confirm")
              .setCta()
              .onClick(() => {
                this.accepted = true;
                this.close();
              });
            if (destructive) b.setWarning();
          });
      }
      onClose(): void {
        resolve(this.accepted);
        this.contentEl.empty();
      }
    }
    new Confirm(app).open();
  });
}
export interface Field {
  key: string;
  label: string;
  secret?: boolean;
  value?: string;
}
export function form(
  app: App,
  title: string,
  fields: Field[],
  description = "",
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    class Form extends Modal {
      private result: Record<string, string> | null = null;
      onOpen(): void {
        this.modalEl.addClass("remote-sync-dialog");
        pageHeader(this.contentEl, title);
        if (description) this.contentEl.createEl("p", { text: description });
        const formEl = this.contentEl.createEl("form", {
          cls: "remote-sync-form",
        });
        const inputs: HTMLInputElement[] = [];
        let submitted = false;
        const submit = () => {
          if (submitted) return;
          submitted = true;
          this.result = Object.fromEntries(
            fields.map((field, i) => [field.key, inputs[i]!.value]),
          );
          inputs.forEach((input) => (input.value = ""));
          this.close();
        };
        formEl.addEventListener("submit", (event) => {
          event.preventDefault();
          submit();
        });
        formEl.addEventListener("keydown", (event) => {
          if (
            event.key === "Enter" &&
            !event.isComposing &&
            inputs.includes(event.target as HTMLInputElement)
          ) {
            event.preventDefault();
            submit();
          }
        });
        for (const field of fields) {
          new Setting(formEl).setName(field.label).addText((t) => {
            t.inputEl.type = field.secret ? "password" : "text";
            t.inputEl.autocomplete = "off";
            t.setValue(field.value ?? "");
            inputs.push(t.inputEl);
          });
        }
        new Setting(formEl)
          .addButton((b) => {
            b.setButtonText("Cancel").onClick(() => this.close());
            b.buttonEl.type = "button";
          })
          .addButton((b) => {
            b.setButtonText("Continue").setCta();
            b.buttonEl.type = "submit";
          });
        inputs[0]?.focus();
      }
      onClose(): void {
        resolve(this.result);
        this.contentEl.empty();
      }
    }
    new Form(app).open();
  });
}
export function downloadFile(name: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function pickFile(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        if (file.size > MAX_CREDENTIAL_FILE_SIZE)
          return reject(new Error("Credential file too large"));
        void file.text().then(resolve, reject);
      },
      { once: true },
    );
    input.click();
  });
}
