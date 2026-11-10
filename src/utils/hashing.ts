import { sha256 } from "@noble/hashes/sha256";
import { md5 } from "@noble/hashes/legacy";
import { bytesToHex } from "@noble/hashes/utils";
export type Digest = { sha256: string; md5: string };
export function hashes(data: ArrayBuffer): Digest {
  const bytes = new Uint8Array(data);
  return { sha256: bytesToHex(sha256(bytes)), md5: bytesToHex(md5(bytes)) };
}
/** Native SHA-256 avoids blocking the renderer. Legacy digest fallbacks yield
 * between chunks so network callbacks, cancellation and progress can advance. */
export async function contentHashes(
  data: ArrayBuffer,
  includeMd5 = false,
): Promise<{ sha256: string; md5?: string }> {
  const bytes = new Uint8Array(data);
  const sha = async () => {
    // Avoid native dispatch/copy overhead for tiny notes. This bounded work is
    // sub-millisecond on typical desktops; large buffers use native async work.
    if (bytes.byteLength <= 32 * 1024) return bytesToHex(sha256(bytes));
    try {
      if (globalThis.crypto?.subtle)
        return bytesToHex(
          new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        );
    } catch {
      /* Use the portable implementation if native crypto is unavailable. */
    }
    return digestInChunks(bytes, sha256.create());
  };
  const [shaHash, md5Hash] = await Promise.all([
    sha(),
    includeMd5 ? digestInChunks(bytes, md5.create()) : undefined,
  ]);
  return { sha256: shaHash, ...(md5Hash ? { md5: md5Hash } : {}) };
}
async function digestInChunks(
  bytes: Uint8Array,
  digest: { update(data: Uint8Array): unknown; digest(): Uint8Array },
): Promise<string> {
  const chunk = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    digest.update(bytes.subarray(offset, offset + chunk));
    if (offset + chunk < bytes.byteLength)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return bytesToHex(digest.digest());
}
export function checksum(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
export async function checksumAsync(text: string): Promise<string> {
  return (await contentHashes(new TextEncoder().encode(text).buffer)).sha256;
}
export function randomId(): string {
  return crypto.randomUUID();
}
