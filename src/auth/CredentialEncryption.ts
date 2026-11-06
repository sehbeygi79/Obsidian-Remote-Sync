import {
  migrateCredentials,
  selectedCredentials,
  validateConfiguration,
  type RemoteConfiguration,
} from "./RemoteConfiguration";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export interface Credentials {
  version: 1;
  clientType: "desktop";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
  accountId: string;
  accountEmail: string;
  folderId: string;
  folderName: string;
  photoUrl?: string;
  displayName?: string;
  refreshTokenExpiresAt?: number;
}
export interface Envelope {
  purpose: "obsidian-remote-sync-credentials";
  version: 1 | 2;
  cipher: "AES-256-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: 600000;
  salt: string;
  iv: string;
  ciphertext: string;
}
const encoder = new TextEncoder();
const aad = (version: number) =>
  encoder.encode(
    `obsidian-remote-sync-credentials:${version}:AES-256-GCM:PBKDF2-SHA256:600000`,
  );
export const MAX_CREDENTIAL_FILE_SIZE = 2_000_000;
export function photoUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "googleusercontent.com" ||
        url.hostname.endsWith(".googleusercontent.com") ||
        url.hostname.endsWith(".ggpht.com"))
    )
      return url.href;
  } catch {
    /* Use an initials avatar if the photo is unavailable. */
  }
  return undefined;
}
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function unbase64(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(s))
    throw new Error("Invalid encrypted credential format");
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("Invalid encrypted credential format");
  }
}
export function validateCredentials(value: unknown): Credentials {
  if (!value || typeof value !== "object")
    throw new Error("Invalid credential payload");
  const v = value as Record<string, unknown>;
  const keys = [
    "clientId",
    "clientSecret",
    "refreshToken",
    "accountId",
    "accountEmail",
    "folderId",
    "folderName",
  ] as const;
  if (
    v.version !== 1 ||
    v.clientType !== "desktop" ||
    keys.some(
      (k) => typeof v[k] !== "string" || (v[k] as string).length > 8192,
    ) ||
    !v.clientId ||
    !v.refreshToken ||
    !Array.isArray(v.scopes) ||
    !v.scopes.every((s) => typeof s === "string") ||
    !v.scopes.includes(DRIVE_SCOPE)
  )
    throw new Error("Invalid credentials or required Drive scope missing");
  if (v.folderId && !/^[\w-]+$/u.test(v.folderId as string))
    throw new Error("Invalid remote folder identity");
  if (
    v.refreshTokenExpiresAt !== undefined &&
    (!Number.isSafeInteger(v.refreshTokenExpiresAt) ||
      (v.refreshTokenExpiresAt as number) <= 0)
  )
    throw new Error("Invalid refresh-token expiry");
  return {
    ...(photoUrl(v.photoUrl) ? { photoUrl: photoUrl(v.photoUrl) } : {}),
    ...(typeof v.displayName === "string" && v.displayName.length <= 512
      ? { displayName: v.displayName }
      : {}),
    ...(v.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: v.refreshTokenExpiresAt as number }
      : {}),
    version: 1,
    clientType: "desktop",
    clientId: v.clientId as string,
    clientSecret: v.clientSecret as string,
    refreshToken: v.refreshToken as string,
    scopes: [...v.scopes] as string[],
    accountId: v.accountId as string,
    accountEmail: v.accountEmail as string,
    folderId: v.folderId as string,
    folderName: v.folderName as string,
  };
}
export function parseEnvelope(raw: string): Envelope {
  if (raw.length > MAX_CREDENTIAL_FILE_SIZE)
    throw new Error("Credential file too large");
  let v: Envelope;
  try {
    v = JSON.parse(raw) as Envelope;
  } catch {
    throw new Error("Invalid encrypted credential file");
  }
  if (
    !v ||
    v.purpose !== "obsidian-remote-sync-credentials" ||
    (v.version !== 1 && v.version !== 2) ||
    v.cipher !== "AES-256-GCM" ||
    v.kdf !== "PBKDF2-SHA256" ||
    v.iterations !== 600000 ||
    unbase64(v.salt).length !== 16 ||
    unbase64(v.iv).length !== 12 ||
    unbase64(v.ciphertext).length < 16
  )
    throw new Error("Unsupported encrypted credential format");
  return v;
}
async function derive(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(
  credentials: Credentials | RemoteConfiguration,
  key: CryptoKey,
  salt: string,
): Promise<Envelope> {
  const payload =
    credentials.version === 2
      ? validateConfiguration(credentials)
      : validateCredentials(credentials);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(credentials.version) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    purpose: "obsidian-remote-sync-credentials",
    version: credentials.version,
    cipher: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 600000,
    salt,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}
export async function encrypt(
  credentials: Credentials | RemoteConfiguration,
  passphrase: string,
): Promise<{ envelope: Envelope; key: CryptoKey }> {
  if (passphrase.length < 12)
    throw new Error("Use a passphrase with at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    key = await derive(passphrase, salt);
  return { envelope: await seal(credentials, key, base64(salt)), key };
}
export async function decryptConfiguration(
  envelope: Envelope,
  passphrase: string,
): Promise<{ configuration: RemoteConfiguration; key: CryptoKey }> {
  parseEnvelope(JSON.stringify(envelope));
  const key = await derive(passphrase, unbase64(envelope.salt));
  try {
    const clear = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(envelope.iv),
        additionalData: aad(envelope.version),
      },
      key,
      unbase64(envelope.ciphertext),
    );
    try {
      const payload: unknown = JSON.parse(new TextDecoder().decode(clear));
      const configuration =
        envelope.version === 2
          ? validateConfiguration(payload)
          : migrateCredentials(validateCredentials(payload));
      return { configuration, key };
    } finally {
      new Uint8Array(clear).fill(0);
    }
  } catch {
    throw new Error(
      "Wrong passphrase, damaged bundle or invalid credential payload",
    );
  }
}

export async function decrypt(
  envelope: Envelope,
  passphrase: string,
): Promise<{ credentials: Credentials; key: CryptoKey }> {
  const result = await decryptConfiguration(envelope, passphrase);
  return {
    credentials: selectedCredentials(result.configuration),
    key: result.key,
  };
}
