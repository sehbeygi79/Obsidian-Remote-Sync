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
}
export interface AuthProvider {
  token(force?: boolean): Promise<string>;
  lock(): void;
}
export class OAuthManager implements AuthProvider {
  private access = "";
  private expires = 0;
  constructor(
    private http: Http,
    private credentials: () => Credentials,
    private persist: () => Promise<void>,
  ) {}
  lock(): void {
    this.access = "";
    this.expires = 0;
  }
  async token(force = false): Promise<string> {
    if (!force && this.access && Date.now() < this.expires - 60000)
      return this.access;
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
    if (response.status === 400 || response.status === 401)
      throw new Error(
        "Refresh token revoked, expired or incompatible with this OAuth client. Reconnect on Ubuntu.",
      );
    ok(response);
    const t = json<TokenResponse>(response);
    if (!t.access_token || !Number.isFinite(t.expires_in) || t.expires_in! <= 0)
      throw new Error("Invalid OAuth token response");
    if (t.scope && !t.scope.split(" ").includes(DRIVE_SCOPE))
      throw new Error("Required Drive permission was revoked");
    if (t.refresh_token && t.refresh_token !== c.refreshToken) {
      c.refreshToken = t.refresh_token;
      await this.persist();
    }
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
  });
}
