import { validateCredentials, type Credentials } from "./CredentialEncryption";
import { randomId } from "../utils/hashing";

export interface SavedAccount {
  id: string;
  credentials: Credentials;
}
export interface RemoteProfile {
  id: string;
  name: string;
  accountRef: string;
  folderId: string;
  folderName: string;
}
export interface RemoteConfiguration {
  version: 2;
  accounts: SavedAccount[];
  remotes: RemoteProfile[];
  activeRemoteId: string;
  activeAccountId: string;
}
export function emptyConfiguration(): RemoteConfiguration {
  return {
    version: 2,
    accounts: [],
    remotes: [],
    activeRemoteId: "",
    activeAccountId: "",
  };
}
export function migrateCredentials(
  credentials: Credentials,
): RemoteConfiguration {
  const config = emptyConfiguration();
  const account = {
    id: randomId(),
    credentials: { ...credentials, folderId: "", folderName: "" },
  };
  config.accounts.push(account);
  config.activeAccountId = account.id;
  if (credentials.folderId) {
    const remote = {
      id: randomId(),
      name: credentials.folderName.slice(0, 512) || "My remote",
      accountRef: account.id,
      folderId: credentials.folderId,
      folderName: credentials.folderName,
    };
    config.remotes.push(remote);
    config.activeRemoteId = remote.id;
  }
  return config;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,256}$/u.test(value);
}
function label(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512;
}
export function validateConfiguration(value: unknown): RemoteConfiguration {
  if (!value || typeof value !== "object")
    throw new Error("Invalid remote configuration");
  const v = value as RemoteConfiguration;
  if (
    v.version !== 2 ||
    !Array.isArray(v.accounts) ||
    !Array.isArray(v.remotes) ||
    v.accounts.length > 100 ||
    v.remotes.length > 1000
  )
    throw new Error("Invalid remote configuration");
  const accountIds = new Set<string>(),
    googleIds = new Set<string>(),
    remoteIds = new Set<string>(),
    targets = new Set<string>();
  const accounts = v.accounts.map((account) => {
    if (!account || !identifier(account.id) || accountIds.has(account.id))
      throw new Error("Invalid account identity");
    const credentials = validateCredentials(account.credentials);
    if (
      !credentials.accountId ||
      googleIds.has(credentials.accountId) ||
      credentials.folderId ||
      credentials.folderName
    )
      throw new Error("Invalid or duplicate Google account");
    accountIds.add(account.id);
    googleIds.add(credentials.accountId);
    return { id: account.id, credentials };
  });
  const remotes = v.remotes.map((remote) => {
    if (
      !remote ||
      !identifier(remote.id) ||
      remoteIds.has(remote.id) ||
      !label(remote.name) ||
      !remote.name.trim() ||
      typeof remote.folderName !== "string" ||
      remote.folderName.length > 8192 ||
      !accountIds.has(remote.accountRef) ||
      !identifier(remote.folderId)
    )
      throw new Error("Invalid remote profile");
    const target = JSON.stringify([remote.accountRef, remote.folderId]);
    if (targets.has(target))
      throw new Error("This account and folder already have a remote profile");
    targets.add(target);
    remoteIds.add(remote.id);
    return {
      id: remote.id,
      name: remote.name.trim(),
      accountRef: remote.accountRef,
      folderId: remote.folderId,
      folderName: remote.folderName,
    };
  });
  if (
    typeof v.activeRemoteId !== "string" ||
    typeof v.activeAccountId !== "string" ||
    (v.activeRemoteId && !remoteIds.has(v.activeRemoteId)) ||
    (v.activeAccountId && !accountIds.has(v.activeAccountId)) ||
    (accounts.length && !v.activeAccountId) ||
    (remotes.length && !v.activeRemoteId)
  )
    throw new Error("Invalid active remote or account");
  if (
    v.activeRemoteId &&
    remotes.find((r) => r.id === v.activeRemoteId)!.accountRef !==
      v.activeAccountId
  )
    throw new Error("Active remote does not belong to the active account");
  return {
    version: 2,
    accounts,
    remotes,
    activeRemoteId: v.activeRemoteId,
    activeAccountId: v.activeAccountId,
  };
}
export function selectedCredentials(config: RemoteConfiguration): Credentials {
  const remote = config.remotes.find((r) => r.id === config.activeRemoteId);
  const account = config.accounts.find(
    (a) => a.id === (remote?.accountRef ?? config.activeAccountId),
  );
  if (!account) throw new Error("Connect or import a Google account first");
  return {
    ...account.credentials,
    folderId: remote?.folderId ?? "",
    folderName: remote?.folderName ?? "",
  };
}
