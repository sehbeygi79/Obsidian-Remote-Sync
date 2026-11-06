// This module is only invoked after Platform.isDesktopApp has been checked.
import { Platform } from "obsidian";
import { base64, DRIVE_SCOPE } from "./CredentialEncryption";
export async function desktopCode(
  clientId: string,
  open: (url: string) => void,
  signal?: AbortSignal,
): Promise<{ code: string; verifier: string; redirectUri: string }> {
  if (!Platform.isDesktopApp)
    throw new Error("Desktop OAuth is unavailable on mobile");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createServer }: typeof import("node:http") = require("node:http");
  const state = crypto.randomUUID();
  const verifier = base64(crypto.getRandomValues(new Uint8Array(48)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const challenge = base64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.close();
      if (error) reject(error);
      else resolve({ code: code!, verifier, redirectUri });
    };
    const abort = () => finish(new Error("Authentication cancelled"));
    let redirectUri = "";
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (req.method !== "GET" || u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("Invalid state");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("Remote Sync: return to Obsidian.");
      const code = u.searchParams.get("code");
      finish(
        code ? undefined : new Error("Google authorization declined"),
        code ?? undefined,
      );
    });
    const timer = setTimeout(
      () => finish(new Error("Authentication timed out")),
      300000,
    );
    server.on("error", () =>
      finish(new Error("Could not open OAuth loopback listener")),
    );
    signal?.addEventListener("abort", abort, { once: true });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string")
        return finish(new Error("Invalid loopback address"));
      redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      if (signal?.aborted) return abort();
      const p = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: DRIVE_SCOPE,
        access_type: "offline",
        prompt: "consent select_account",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      try {
        open(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
      } catch {
        finish(new Error("Could not open system browser"));
      }
    });
  });
}
