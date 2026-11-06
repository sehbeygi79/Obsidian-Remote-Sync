export interface FileState {
  path: string;
  size: number;
  hashes: { sha256?: string; md5?: string };
  modifiedAt: number;
  localId?: string;
  id?: string;
  version?: string;
  etag?: string;
  parents?: string[];
}
export interface Snapshot {
  files: Record<string, FileState>;
  blocked: string[];
  warnings: string[];
  scannedAt: number;
  identity: string;
}
export interface Baseline {
  key: string;
  path: string;
  hash: FileState["hashes"] | null;
  size: number;
  remoteId?: string;
  syncedAt: number;
  local: FileState | null;
  remote: FileState | null;
}
export type Action =
  | "upload"
  | "download"
  | "use-local"
  | "use-remote"
  | "trash-local"
  | "trash-remote"
  | "local-path"
  | "remote-path"
  | "accept"
  | "skip";
export type Category =
  | "addition"
  | "modification"
  | "deletion"
  | "rename"
  | "conflict"
  | "equal"
  | "blocked";
export interface Change {
  key: string;
  path: string;
  localPath: string;
  remotePath: string;
  local: FileState | null;
  remote: FileState | null;
  baseline: Baseline | null;
  category: Category;
  classification: string;
  explanation: string;
  actions: Action[];
  suggested: Action;
}
export interface Review {
  local: Snapshot;
  remote: Snapshot;
  changes: Change[];
  context: string;
}
export interface Selection {
  change: Change;
  action: Action;
}
export type ByteProgress = (transferred: number, total: number) => void;
export interface TransferProgress {
  path: string;
  direction: "upload" | "download";
  transferred: number;
  total: number;
  phase: "preparing" | "transferring" | "verifying";
}
export interface LocalBackend {
  scan(): Promise<Snapshot>;
  read(path: string): Promise<ArrayBuffer>;
  write(
    path: string,
    data: ArrayBuffer,
    expected: FileState | null,
  ): Promise<void>;
  rename(source: string, target: string, expected: FileState): Promise<void>;
  trash(path: string, expected: FileState): Promise<void>;
}
export interface RemoteBackend {
  scan(): Promise<Snapshot>;
  read(file: FileState, onProgress?: ByteProgress): Promise<ArrayBuffer>;
  reserveId(): Promise<string>;
  upload(
    path: string,
    data: ArrayBuffer,
    expected: FileState | null,
    newId?: string,
    onProgress?: ByteProgress,
  ): Promise<void>;
  rename(file: FileState, target: string): Promise<void>;
  trash(file: FileState): Promise<void>;
}
export interface Observation {
  status?: "Success" | "Failed";
  reason?: string;
  at: number;
  context: string;
  files: Change[];
}
export type Status =
  "Running" | "Success" | "Failed" | "Needs Rescan" | "Skipped" | "Cancelled";
export interface Operation {
  id: string;
  session: string;
  at: number;
  finishedAt?: number;
  context: string;
  path: string;
  action: Action;
  status: Status;
  reason?: string;
  before: { local: FileState | null; remote: FileState | null };
  after?: { local: FileState | null; remote: FileState | null };
  remoteId?: string;
}
export interface SeenFile {
  firstSeenAt: number;
  lastSeenAt: number;
  local: FileState | null;
  remote: FileState | null;
  classification: string;
}
export interface DeviceState {
  schema: 1;
  deviceId: string;
  retentionDays: number;
  baselines: Record<string, Record<string, Baseline>>;
  seen: Record<string, Record<string, SeenFile>>;
  observations: Observation[];
  operations: Operation[];
  journal: Operation[];
}
