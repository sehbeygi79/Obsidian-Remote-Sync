export function stamp(at: number | null | undefined): string {
  return at ? new Date(at).toLocaleString() : "Never";
}
export function size(bytes: number | undefined): string {
  if (bytes === undefined) return "Missing";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
