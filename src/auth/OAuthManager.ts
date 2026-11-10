import {
  DRIVE_SCOPE,
  validateCredentials,
  type Credentials,
} from "./CredentialEncryption";
import { json, ok, type Http } from "../drive/Http";
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  refresh_token_expires_in?: number;
}
export function refreshExpiry(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(Date.now() + value * 1000)
  )
    throw new Error("Invalid refresh-token lifetime");
  return Date.now() + value * 1000;
}
export interface AuthProvider {
  token(force?: boolean): Promise<string>;
  lock(): void;
}
export class OAuthManager implements AuthProvider {
  private access = "";
  private expires = 0;
  private refreshing?: Promise<string>;
  private generation = 0;
  needsReconnect = false;
  get expiresAt(): number | undefined {
    return this.access ? this.expires : undefined;
  }
  constructor(
    private http: Http,
    private credentials: () => Credentials,
    private persist: () => Promise<void>,
  ) {}
  lock(): void {
    this.generation++;
    this.refreshing = undefined;
    this.access = "";
    this.expires = 0;
    this.needsReconnect = false;
  }
  async token(force = false): Promise<string> {
    if (!force && this.access && Date.now() < this.expires - 60000)
      return this.access;
    if (this.refreshing) return this.refreshing;
    const pending = this.refresh(this.generation);
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = undefined;
    }
  }
  private async refresh(generation: number): Promise<string> {
    const c = this.credentials();
    const response = await this.http({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (generation !== this.generation)
      throw new Error("Credentials locked during token refresh");
    if (response.status === 400 || response.status === 401) {
      this.access = "";
      this.expires = 0;
      this.needsReconnect = true;
      throw new Error(
        "Refresh token revoked, expired or incompatible with this OAuth client. Reconnect on Ubuntu.",
      );
    }
    ok(response);
    const t = json<TokenResponse>(response);
    if (!t.access_token || !Number.isFinite(t.expires_in) || t.expires_in! <= 0)
      throw new Error("Invalid OAuth token response");
    if (t.scope && !t.scope.split(" ").includes(DRIVE_SCOPE))
      throw new Error("Required Drive permission was revoked");
    const deadline = refreshExpiry(t.refresh_token_expires_in);
    if (
      (t.refresh_token && t.refresh_token !== c.refreshToken) ||
      deadline !== undefined
    ) {
      const previous = {
        token: c.refreshToken,
        deadline: c.refreshTokenExpiresAt,
      };
      if (t.refresh_token && t.refresh_token !== c.refreshToken) {
        c.refreshToken = t.refresh_token;
        delete c.refreshTokenExpiresAt;
      }
      if (deadline !== undefined) c.refreshTokenExpiresAt = deadline;
      try {
        await this.persist();
      } catch (error) {
        c.refreshToken = previous.token;
        if (previous.deadline === undefined) delete c.refreshTokenExpiresAt;
        else c.refreshTokenExpiresAt = previous.deadline;
        throw error;
      }
    }
    if (generation !== this.generation)
      throw new Error("Credentials locked during token refresh");
    this.needsReconnect = false;
    this.access = t.access_token;
    this.expires = Date.now() + t.expires_in! * 1000;
    return this.access;
  }
}
export async function exchangeCode(
  http: Http,
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Credentials> {
  const r = await http({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  ok(r);
  const t = json<TokenResponse>(r);
  if (!t.refresh_token || !t.scope)
    throw new Error(
      "No offline refresh token or scopes returned. Revoke the old grant and reconnect with consent.",
    );
  return validateCredentials({
    version: 1,
    clientType: "desktop",
    clientId,
    clientSecret,
    refreshToken: t.refresh_token,
    scopes: t.scope.split(" "),
    accountId: "",
    accountEmail: "",
    folderId: "",
    folderName: "",
    refreshTokenExpiresAt: refreshExpiry(t.refresh_token_expires_in),
  });
}
