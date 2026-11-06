import {
  decrypt,
  encrypt,
  parseEnvelope,
  seal,
  type Credentials,
  type Envelope,
} from "./CredentialEncryption";
export class CredentialStore {
  private clear: Credentials | null = null;
  private key: CryptoKey | null = null;
  constructor(
    public envelope: Envelope | null,
    private save: (envelope: Envelope | null) => Promise<void>,
  ) {}
  get unlocked(): boolean {
    return !!this.clear;
  }
  get credentials(): Credentials {
    if (!this.clear) throw new Error("Credentials locked");
    return this.clear;
  }
  lock(): void {
    this.clear = null;
    this.key = null;
  }
  async unlock(passphrase: string): Promise<void> {
    if (!this.envelope)
      throw new Error("Connect or import encrypted credentials first");
    const result = await decrypt(this.envelope, passphrase);
    this.clear = result.credentials;
    this.key = result.key;
  }
  async install(credentials: Credentials, passphrase: string): Promise<void> {
    const result = await encrypt(credentials, passphrase);
    await this.save(result.envelope);
    this.envelope = result.envelope;
    this.clear = credentials;
    this.key = result.key;
  }
  async persist(): Promise<void> {
    if (!this.key || !this.envelope) throw new Error("Credentials locked");
    const next = await seal(this.credentials, this.key, this.envelope.salt);
    await this.save(next);
    this.envelope = next;
  }
  async import(
    raw: string,
    passphrase: string,
    validate: (c: Credentials) => Promise<void>,
    localPassphrase = passphrase,
  ): Promise<void> {
    const { credentials } = await decrypt(parseEnvelope(raw), passphrase);
    if (!credentials.folderId || !credentials.accountId)
      throw new Error(
        "Bundle must include a validated account and selected folder",
      );
    await validate(credentials);
    await this.install(credentials, localPassphrase);
  }
  async changePassphrase(current: string, next: string): Promise<void> {
    if (!this.envelope) throw new Error("No credentials stored");
    const { credentials } = await decrypt(this.envelope, current);
    await this.install(credentials, next);
  }
  async disconnect(): Promise<void> {
    await this.save(null);
    this.envelope = null;
    this.lock();
  }
}
