export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  data: ArrayBuffer;
}
export type Http = (request: HttpRequest) => Promise<HttpResponse>;
export function json<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error("Invalid server response");
  }
}
export function header(
  response: HttpResponse,
  name: string,
): string | undefined {
  return Object.entries(response.headers).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  )?.[1];
}
export class ServiceError extends Error {
  constructor(public status: number) {
    super(
      status === 401
        ? "Authorization expired or revoked. Unlock again or reconnect."
        : status === 403
          ? "Drive permission or quota error. No missing-file inference was made."
          : status === 429
            ? "Drive rate limit. Wait, then manually rescan."
            : status === 412
              ? "Needs Rescan: server rejected a stale precondition."
              : `Remote request failed (HTTP ${status}). Rescan before retrying.`,
    );
  }
}
export function ok(response: HttpResponse): void {
  if (response.status < 200 || response.status >= 300)
    throw new ServiceError(response.status);
}
