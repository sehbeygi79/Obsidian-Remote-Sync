import { sha256 } from "@noble/hashes/sha256";
import { md5 } from "@noble/hashes/legacy";
import { bytesToHex } from "@noble/hashes/utils";
export type Digest = { sha256: string; md5: string };
export function hashes(data: ArrayBuffer): Digest {
  const bytes = new Uint8Array(data);
  return { sha256: bytesToHex(sha256(bytes)), md5: bytesToHex(md5(bytes)) };
}
export function checksum(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
export function randomId(): string {
  return crypto.randomUUID();
}
