export const DEFAULT_CONCURRENT_TRANSFERS = 3;
export const MAX_CONCURRENT_TRANSFERS = 8;
export const TRANSFER_CHUNK_SIZES = [256, 512, 1024, 2048, 4096, 8192].map(
  (kib) => kib * 1024,
);
export const DEFAULT_TRANSFER_CHUNK = 8 * 1024 * 1024;
export function transferChunkSize(value: unknown): number {
  return typeof value === "number" && TRANSFER_CHUNK_SIZES.includes(value)
    ? value
    : DEFAULT_TRANSFER_CHUNK;
}
export function concurrentTransfers(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_TRANSFERS
    ? value
    : DEFAULT_CONCURRENT_TRANSFERS;
}
