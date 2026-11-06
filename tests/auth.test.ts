import { describe, it, expect, vi } from "vitest";
import { CredentialStore } from "../src/auth/CredentialStore";
import {
  decrypt,
  encrypt,
  parseEnvelope,
  validateCredentials,
  DRIVE_SCOPE,
  type Credentials,
  type Envelope,
} from "../src/auth/CredentialEncryption";
import { OAuthManager, exchangeCode } from "../src/auth/OAuthManager";
import { EncryptedConfig } from "../src/auth/EncryptedConfig";
import { bytes } from "./helpers";
import type { HttpRequest } from "../src/drive/Http";
const pass = "a long unique passphrase";
const c: Credentials = {
  version: 1,
  clientType: "desktop",
  clientId: "desktop.apps.googleusercontent.com",
  clientSecret: "client-secret",
  refreshToken: "refresh-secret",
  scopes: [DRIVE_SCOPE],
  accountId: "account",
  accountEmail: "a@example.test",
  folderId: "folder",
  folderName: "Materials",
};
const response = (data: unknown, status = 200) => ({
  status,
  headers: {},
  text: JSON.stringify(data),
  data: bytes(""),
});
describe("encrypted credentials and transfer", () => {
  it("roundtrips desktop bundle through mobile-compatible Web Crypto", async () => {
    const { envelope } = await encrypt(c, pass);
    expect((await decrypt(envelope, pass)).credentials).toEqual(c);
    expect(JSON.stringify(envelope)).not.toContain("refresh-secret");
  });
  it("rejects wrong passphrase", async () => {
    const { envelope } = await encrypt(c, pass);
    await expect(decrypt(envelope, "wrong")).rejects.toThrow(
      "Wrong passphrase",
    );
  });
  it("rejects tampered ciphertext", async () => {
    const { envelope } = await encrypt(c, pass);
    envelope.ciphertext =
      (envelope.ciphertext[0] === "A" ? "B" : "A") +
      envelope.ciphertext.slice(1);
    await expect(decrypt(envelope, pass)).rejects.toThrow();
  });
  it("uses independent salt and nonce", async () => {
    const a = await encrypt(c, pass),
      b = await encrypt(c, pass);
    expect(a.envelope.salt).not.toBe(b.envelope.salt);
    expect(a.envelope.iv).not.toBe(b.envelope.iv);
  });
  it.each(["version", "purpose", "iterations", "cipher", "kdf"])(
    "rejects unsupported %s",
    async (key) => {
      const { envelope } = await encrypt(c, pass);
      expect(() =>
        parseEnvelope(JSON.stringify({ ...envelope, [key]: "invalid" })),
      ).toThrow();
    },
  );
  it("validates payload and rejects Android-client substitution", () => {
    expect(() =>
      validateCredentials({ ...c, clientType: "android" }),
    ).toThrow();
    expect(() =>
      validateCredentials({ ...c, scopes: ["drive.file"] }),
    ).toThrow();
    expect(() => validateCredentials({ ...c, refreshToken: "" })).toThrow();
  });
  it("rejects oversized or malformed encrypted input", () => {
    expect(() => parseEnvelope("x".repeat(100001))).toThrow();
    expect(() => parseEnvelope("{}")).toThrow();
  });
  it("stores encrypted values only and supports lock/unlock", async () => {
    let disk: Envelope | null = null;
    const store = new CredentialStore(null, async (e) => {
      disk = e;
    });
    await store.install({ ...c }, pass);
    expect(store.unlocked).toBe(true);
    expect(JSON.stringify(disk)).not.toContain(c.refreshToken);
    store.lock();
    expect(() => store.credentials).toThrow("locked");
    await store.unlock(pass);
    expect(store.credentials).toEqual(c);
  });
  it("validates imported token before persisting and rejects invalid grant", async () => {
    const { envelope } = await encrypt(c, pass),
      save = vi.fn(),
      s = new CredentialStore(null, save);
    await expect(
      s.import(JSON.stringify(envelope), pass, async () => {
        throw new Error("invalid token");
      }),
    ).rejects.toThrow("invalid token");
    expect(save).not.toHaveBeenCalled();
  });
  it("imports same issuing client configuration and no baseline/history", async () => {
    const source = await encrypt(c, pass),
      save = vi.fn(),
      s = new CredentialStore(null, save),
      validate = vi.fn(async () => {});
    await s.import(JSON.stringify(source.envelope), pass, validate);
    expect(validate).toHaveBeenCalledOnce();
    expect(s.credentials.clientId).toBe(c.clientId);
    expect(Object.keys(s.credentials)).not.toContain("baselines");
  });
  it("does not replace credentials when persistent write fails", async () => {
    const source = await encrypt(c, pass),
      s = new CredentialStore(source.envelope, async () => {
        throw new Error("disk");
      });
    await s.unlock(pass);
    await expect(
      s.changePassphrase(pass, "new long passphrase"),
    ).rejects.toThrow("disk");
    expect(s.envelope).toEqual(source.envelope);
  });
  it("changes passphrase only after verifying current passphrase", async () => {
    const s = new CredentialStore(null, async () => {});
    await s.install({ ...c }, pass);
    await expect(
      s.changePassphrase("bad", "new long passphrase"),
    ).rejects.toThrow();
    await s.changePassphrase(pass, "new long passphrase");
    await expect(decrypt(s.envelope!, pass)).rejects.toThrow();
    expect(
      (await decrypt(s.envelope!, "new long passphrase")).credentials,
    ).toEqual(c);
  });
  it("disconnect removes encrypted state and memory", async () => {
    const save = vi.fn(),
      s = new CredentialStore(null, save);
    await s.install({ ...c }, pass);
    await s.disconnect();
    expect(save).toHaveBeenLastCalledWith(null);
    expect(s.unlocked).toBe(false);
  });
  it("persistent encrypted config overwrites both old-passphrase slots", async () => {
    const data = new Map<string, string>();
    const cfg = new EncryptedConfig(
      {
        read: async (p) => data.get(p)!,
        write: async (p, v) => {
          data.set(p, v);
        },
        exists: async (p) => data.has(p),
      },
      "c",
    );
    const old = await encrypt(c, pass),
      next = await encrypt(c, "different long pass");
    await cfg.save(old.envelope);
    await cfg.save(next.envelope);
    expect(
      [...data.values()].some((v) => v.includes(old.envelope.ciphertext)),
    ).toBe(false);
    expect(await cfg.load()).toEqual(next.envelope);
  });
});
describe("OAuth requests", () => {
  it("refreshes with the original Desktop client on Android without redirect", async () => {
    const http = vi.fn(async (_request: HttpRequest) =>
      response({
        access_token: "access-secret",
        expires_in: 3600,
        scope: DRIVE_SCOPE,
      }),
    );
    const m = new OAuthManager(
      http,
      () => ({ ...c }),
      async () => {},
    );
    expect(await m.token()).toBe("access-secret");
    const body = new URLSearchParams(http.mock.calls[0]![0]!.body as string);
    expect(body.get("client_id")).toBe(c.clientId);
    expect(body.get("client_secret")).toBe(c.clientSecret);
    expect(body.has("redirect_uri")).toBe(false);
    await m.token();
    expect(http).toHaveBeenCalledOnce();
    m.lock();
    await m.token();
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("rejects expired/revoked refresh token with sanitized message", async () => {
    const m = new OAuthManager(
      async () =>
        response(
          { error: "invalid_grant", refresh_token: c.refreshToken },
          400,
        ),
      () => ({ ...c }),
      async () => {},
    );
    await expect(m.token()).rejects.toThrow("expired");
    await expect(m.token()).rejects.not.toThrow(c.refreshToken);
  });
  it("rejects permissions removed from refresh response", async () => {
    const m = new OAuthManager(
      async () =>
        response({
          access_token: "token",
          expires_in: 3600,
          scope: "drive.file",
        }),
      () => ({ ...c }),
      async () => {},
    );
    await expect(m.token()).rejects.toThrow("permission");
  });
  it("persists refresh-token rotation encrypted through callback", async () => {
    const clear = { ...c },
      save = vi.fn(async () => {}),
      m = new OAuthManager(
        async () =>
          response({
            access_token: "token",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
        () => clear,
        save,
      );
    await m.token();
    expect(clear.refreshToken).toBe("rotated");
    expect(save).toHaveBeenCalledOnce();
  });
  it("does not refresh while idle", () => {
    const http = vi.fn(),
      m = new OAuthManager(
        http,
        () => ({ ...c }),
        async () => {},
      );
    expect(http).not.toHaveBeenCalled();
    m.lock();
    expect(http).not.toHaveBeenCalled();
  });
  it("exchanges code with PKCE and requires offline grant", async () => {
    const http = vi.fn(async (_request: HttpRequest) =>
      response({ refresh_token: c.refreshToken, scope: DRIVE_SCOPE }),
    );
    const result = await exchangeCode(
      http,
      c.clientId,
      c.clientSecret,
      "code",
      "verifier",
      "http://127.0.0.1:123/callback",
    );
    expect(result.clientType).toBe("desktop");
    expect(http.mock.calls[0]![0]!.body).toContain("code_verifier=verifier");
    await expect(
      exchangeCode(
        async () => response({}),
        c.clientId,
        "",
        "code",
        "v",
        "uri",
      ),
    ).rejects.toThrow("offline");
  });
});
