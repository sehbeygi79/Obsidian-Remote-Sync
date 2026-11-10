export const DEFAULT_CONCURRENT_TRANSFERS = 3;
export const MAX_CONCURRENT_TRANSFERS = 8;
export function concurrentTransfers(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_TRANSFERS
    ? value
    : DEFAULT_CONCURRENT_TRANSFERS;
}
