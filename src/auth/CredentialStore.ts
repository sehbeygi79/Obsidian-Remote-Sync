import {
  decryptConfiguration,
  encrypt,
  parseEnvelope,
  seal,
  validateCredentials,
  type Credentials,
  type Envelope,
} from "./CredentialEncryption";
import {
  emptyConfiguration,
  migrateCredentials,
  selectedCredentials,
  validateConfiguration,
  type RemoteConfiguration,
  type RemoteProfile,
} from "./RemoteConfiguration";
import { randomId } from "../utils/hashing";

export class CredentialStore {
  private clear: RemoteConfiguration | null = null;
  private key: CryptoKey | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  constructor(
    public envelope: Envelope | null,
    private save: (envelope: Envelope | null) => Promise<void>,
  ) {}
  get unlocked(): boolean {
    return !!this.clear;
  }
  get configuration(): RemoteConfiguration {
    if (!this.clear) throw new Error("Credentials locked");
    return this.clear;
  }
  get accounts() {
    return this.configuration.accounts;
  }
  get remotes() {
    return this.configuration.remotes;
  }
  get activeRemote(): RemoteProfile | undefined {
    return this.remotes.find((r) => r.id === this.configuration.activeRemoteId);
  }
  get credentials(): Credentials {
    return selectedCredentials(this.configuration);
  }
  account(id = this.configuration.activeAccountId): Credentials {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new Error("Google account no longer exists");
    return account.credentials;
  }
  lock(): void {
    this.revision++;
    this.clear = null;
    this.key = null;
  }
  async unlock(passphrase: string): Promise<void> {
    const envelope = this.envelope,
      revision = this.revision;
    if (!envelope)
      throw new Error("Connect or import encrypted credentials first");
    const result = await decryptConfiguration(envelope, passphrase);
    const next =
      envelope.version === 1
        ? await seal(result.configuration, result.key, envelope.salt)
        : envelope;
    if (revision !== this.revision)
      throw new Error("Credentials locked during unlock");
    if (next !== envelope) await this.save(next);
    if (revision !== this.revision)
      throw new Error("Credentials locked during unlock");
    this.envelope = next;
    this.clear = result.configuration;
    this.key = result.key;
  }
  async install(credentials: Credentials, passphrase: string): Promise<void> {
    const revision = this.revision;
    const config = validateConfiguration(
      migrateCredentials(validateCredentials(credentials)),
    );
    const result = await encrypt(config, passphrase);
    if (revision !== this.revision)
      throw new Error("Credentials locked during save");
    await this.save(result.envelope);
    if (revision !== this.revision)
      throw new Error("Credentials locked during save");
    this.envelope = result.envelope;
    this.clear = config;
    this.key = result.key;
  }
  /** Clone, validate and durably save before exposing configuration edits. */
  update(change: (next: RemoteConfiguration) => void): Promise<void> {
    const revision = this.revision;
    const run = this.queue.then(async () => {
      if (revision !== this.revision || !this.key || !this.envelope)
        throw new Error("Credentials locked");
      const next = structuredClone(this.configuration);
      change(next);
      const valid = validateConfiguration(next);
      const envelope = await seal(valid, this.key, this.envelope.salt);
      parseEnvelope(JSON.stringify(envelope));
      if (revision !== this.revision) throw new Error("Credentials locked");
      await this.save(envelope);
      if (revision !== this.revision) throw new Error("Credentials locked");
      this.clear = valid;
      this.envelope = envelope;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async persist(): Promise<void> {
    await this.update(() => {});
  }
  async addAccount(credentials: Credentials): Promise<string> {
    let ref = "";
    await this.update((next) => {
      let account = next.accounts.find(
        (a) => a.credentials.accountId === credentials.accountId,
      );
      if (!account) {
        account = {
          id: randomId(),
          credentials: { ...credentials, folderId: "", folderName: "" },
        };
        next.accounts.push(account);
      } else
        account.credentials = { ...credentials, folderId: "", folderName: "" };
      ref = account.id;
      if (!next.activeRemoteId) next.activeAccountId = ref;
    });
    return ref;
  }
  async addRemote(
    accountRef: string,
    folderId: string,
    folderName: string,
    name: string,
  ): Promise<string> {
    let id = "";
    await this.update((next) => {
      if (
        next.remotes.some(
          (r) => r.accountRef === accountRef && r.folderId === folderId,
        )
      )
        throw new Error(
          "This account and folder already have a remote profile",
        );
      id = randomId();
      next.remotes.push({ id, name, accountRef, folderId, folderName });
      next.activeRemoteId = id;
      next.activeAccountId = accountRef;
    });
    return id;
  }
  async selectRemote(id: string): Promise<void> {
    await this.update((next) => {
      const remote = next.remotes.find((r) => r.id === id);
      if (!remote) throw new Error("Remote profile no longer exists");
      next.activeRemoteId = id;
      next.activeAccountId = remote.accountRef;
    });
  }
  async renameRemote(id: string, name: string): Promise<void> {
    await this.update((next) => {
      const remote = next.remotes.find((r) => r.id === id);
      if (!remote) throw new Error("Remote profile no longer exists");
      remote.name = name;
    });
  }
  async removeRemote(id: string): Promise<void> {
    await this.update((next) => {
      next.remotes = next.remotes.filter((r) => r.id !== id);
      this.reselect(next);
    });
  }
  async removeAccount(ref: string): Promise<void> {
    await this.update((next) => {
      next.accounts = next.accounts.filter((a) => a.id !== ref);
      next.remotes = next.remotes.filter((r) => r.accountRef !== ref);
      this.reselect(next);
    });
  }
  private reselect(next: RemoteConfiguration): void {
    const remote =
      next.remotes.find((r) => r.id === next.activeRemoteId) ?? next.remotes[0];
    next.activeRemoteId = remote?.id ?? "";
    next.activeAccountId =
      remote?.accountRef ??
      next.accounts.find((a) => a.id === next.activeAccountId)?.id ??
      next.accounts[0]?.id ??
      "";
  }
  async export(remoteId: string): Promise<Envelope> {
    const remote = this.remotes.find((r) => r.id === remoteId);
    if (!remote || !this.key || !this.envelope)
      throw new Error("Select a remote before exporting");
    const config = {
      version: 2 as const,
      accounts: this.accounts.filter((a) => a.id === remote.accountRef),
      remotes: [remote],
      activeRemoteId: remote.id,
      activeAccountId: remote.accountRef,
    };
    return seal(config, this.key, this.envelope.salt);
  }
  async import(
    raw: string,
    passphrase: string,
    validate: (c: Credentials) => Promise<void>,
    localPassphrase = passphrase,
  ): Promise<void> {
    const revision = this.revision;
    const { configuration: incoming } = await decryptConfiguration(
      parseEnvelope(raw),
      passphrase,
    );
    if (!incoming.activeRemoteId)
      throw new Error(
        "Bundle must include a validated account and selected folder",
      );
    for (const account of incoming.accounts) {
      const remotes = incoming.remotes.filter(
        (r) => r.accountRef === account.id,
      );
      for (const remote of remotes.length ? remotes : [undefined]) {
        const candidate = {
          ...account.credentials,
          folderId: remote?.folderId ?? "",
          folderName: remote?.folderName ?? "",
        };
        await validate(candidate);
        account.credentials = { ...candidate, folderId: "", folderName: "" };
        if (remote) remote.folderName = candidate.folderName;
      }
    }
    const merge = (next: RemoteConfiguration) => {
      const refs = new Map<string, string>(),
        ids = new Map<string, string>();
      for (const account of incoming.accounts) {
        let target = next.accounts.find(
          (a) => a.credentials.accountId === account.credentials.accountId,
        );
        if (target) target.credentials = account.credentials;
        else {
          target = { ...account, id: randomId() };
          next.accounts.push(target);
        }
        refs.set(account.id, target.id);
      }
      for (const remote of incoming.remotes) {
        const accountRef = refs.get(remote.accountRef)!;
        let target = next.remotes.find(
          (r) => r.accountRef === accountRef && r.folderId === remote.folderId,
        );
        if (!target) {
          target = { ...remote, id: randomId(), accountRef };
          next.remotes.push(target);
        }
        ids.set(remote.id, target.id);
      }
      next.activeRemoteId = ids.get(incoming.activeRemoteId)!;
      next.activeAccountId = refs.get(incoming.activeAccountId)!;
    };
    if (revision !== this.revision)
      throw new Error("Credentials locked during import");
    if (this.envelope) {
      if (!this.unlocked)
        throw new Error("Unlock existing credentials before importing");
      await this.update(merge);
    } else {
      const next = emptyConfiguration();
      merge(next);
      const result = await encrypt(
        validateConfiguration(next),
        localPassphrase,
      );
      if (revision !== this.revision)
        throw new Error("Credentials locked during import");
      await this.save(result.envelope);
      if (revision !== this.revision)
        throw new Error("Credentials locked during import");
      this.envelope = result.envelope;
      this.clear = next;
      this.key = result.key;
    }
  }
  async changePassphrase(current: string, next: string): Promise<void> {
    const revision = this.revision;
    if (!this.envelope) throw new Error("No credentials stored");
    const { configuration } = await decryptConfiguration(
      this.envelope,
      current,
    );
    const result = await encrypt(configuration, next);
    if (revision !== this.revision)
      throw new Error("Credentials locked during save");
    await this.save(result.envelope);
    if (revision !== this.revision)
      throw new Error("Credentials locked during save");
    this.envelope = result.envelope;
    this.clear = configuration;
    this.key = result.key;
  }
  async disconnect(): Promise<void> {
    await this.save(null);
    this.envelope = null;
    this.lock();
  }
}
