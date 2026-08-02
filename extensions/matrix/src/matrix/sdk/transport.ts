// Matrix plugin module implements transport behavior.
import { parseMediaContentLength } from "openclaw/plugin-sdk/media-runtime";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { LogService } from "./logger.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";
import {
  buildTimeoutAbortSignal,
  closeDispatcher,
  createPinnedDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  resolvePinnedHostnameWithPolicy,
  type SsrFPolicy,
  type PinnedDispatcherPolicy,
} from "./transport-runtime-api.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// Default ceiling for non-raw JSON control-plane responses (whoami, receipts,
// directory search, key-backup status, generic doRequest). Matrix homeservers
// are untrusted, so bound the body the same way the raw media path is bounded
// instead of buffering an unbounded stream via response.text().
const MATRIX_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

// matrix-js-sdk also uses the injected fetch for raw encrypted key bundles.
// Keep that path bounded without applying the tighter control-plane JSON cap.
const MATRIX_SDK_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;

export type QueryParams = Record<string, QueryValue> | null | undefined;

type MatrixDispatcherRequestInit = RequestInit & {
  dispatcher?: ReturnType<typeof createPinnedDispatcher>;
};

type MatrixPinnedDispatcher = ReturnType<typeof createPinnedDispatcher>;
type MatrixPinnedHostname = Awaited<ReturnType<typeof resolvePinnedHostnameWithPolicy>>;

type MatrixDispatcherEntry = {
  dispatcher: MatrixPinnedDispatcher;
  addresses: string[];
  references: number;
  retained: boolean;
  closePromise: Promise<void> | null;
};

type MatrixRequestParams = {
  homeserver: string;
  accessToken: string;
  method: HttpMethod;
  endpoint: string;
  qs?: QueryParams;
  body?: unknown;
  timeoutMs: number;
  raw?: boolean;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  allowAbsoluteEndpoint?: boolean;
};

const MATRIX_TRANSPORT_MAX_RETAINED_DISPATCHERS = 8;

export class MatrixTransportClosedError extends Error {
  readonly code = "MATRIX_TRANSPORT_CLOSED";

  constructor() {
    super("Matrix transport is closed");
    this.name = "MatrixTransportClosedError";
  }
}

function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const remaining = new Set(left);
  if (remaining.size !== new Set(right).size) {
    return false;
  }
  return right.every((address) => remaining.has(address));
}

class MatrixPinnedDispatcherPool {
  private readonly entries = new Set<MatrixDispatcherEntry>();
  private readonly currentByHostname = new Map<string, MatrixDispatcherEntry>();
  private closed = false;
  private closedWarningEmitted = false;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;

  private resolveDrainIfComplete(): void {
    if (!this.closed || this.entries.size > 0) {
      return;
    }
    this.resolveDrain?.();
    this.resolveDrain = null;
  }

  assertOpen(): void {
    if (!this.closed) {
      return;
    }
    if (!this.closedWarningEmitted) {
      this.closedWarningEmitted = true;
      LogService.warn("MatrixTransport", "Rejected request after terminal transport shutdown");
    }
    throw new MatrixTransportClosedError();
  }

  private async closeEntry(entry: MatrixDispatcherEntry): Promise<void> {
    if (!entry.closePromise) {
      entry.closePromise = closeDispatcher(entry.dispatcher).finally(() => {
        this.entries.delete(entry);
        this.resolveDrainIfComplete();
      });
    }
    await entry.closePromise;
  }

  private retire(entry: MatrixDispatcherEntry, reason: "capacity" | "dns-change"): void {
    entry.retained = false;
    LogService.debug("MatrixTransport", `Retiring pinned dispatcher (${reason})`);
    if (entry.references === 0) {
      void this.closeEntry(entry);
    }
  }

  private evictRetainedEntry(): void {
    if (this.currentByHostname.size < MATRIX_TRANSPORT_MAX_RETAINED_DISPATCHERS) {
      return;
    }
    const entry = Array.from(this.currentByHostname.entries()).find(
      ([, candidate]) => candidate.references === 0,
    );
    if (!entry) {
      return;
    }
    this.currentByHostname.delete(entry[0]);
    this.retire(entry[1], "capacity");
  }

  async acquire(params: {
    pinned: MatrixPinnedHostname;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    ssrfPolicy?: SsrFPolicy;
  }): Promise<{ dispatcher: MatrixPinnedDispatcher; release: () => Promise<void> }> {
    this.assertOpen();
    const existing = this.currentByHostname.get(params.pinned.hostname);
    if (existing && !sameAddressSet(existing.addresses, params.pinned.addresses)) {
      this.currentByHostname.delete(params.pinned.hostname);
      this.retire(existing, "dns-change");
    }
    const current = this.currentByHostname.get(params.pinned.hostname);
    const entry =
      current ??
      (() => {
        this.evictRetainedEntry();
        const retained = this.currentByHostname.size < MATRIX_TRANSPORT_MAX_RETAINED_DISPATCHERS;
        const next: MatrixDispatcherEntry = {
          dispatcher: createPinnedDispatcher(
            params.pinned,
            params.dispatcherPolicy,
            params.ssrfPolicy,
          ),
          addresses: params.pinned.addresses,
          references: 0,
          retained,
          closePromise: null,
        };
        this.entries.add(next);
        if (retained) {
          this.currentByHostname.set(params.pinned.hostname, next);
        }
        return next;
      })();
    entry.references += 1;
    let released = false;
    return {
      dispatcher: entry.dispatcher,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        entry.references -= 1;
        if ((!entry.retained || this.closed) && entry.references === 0) {
          await this.closeEntry(entry);
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.drainPromise;
      return;
    }
    this.closed = true;
    this.drainPromise = new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
    this.currentByHostname.clear();
    // Active entries stay alive until their final response-body borrower releases them.
    const idleEntries: MatrixDispatcherEntry[] = [];
    for (const entry of this.entries) {
      entry.retained = false;
      if (entry.references === 0) {
        idleEntries.push(entry);
      }
    }
    for (const entry of idleEntries) {
      void this.closeEntry(entry);
    }
    this.resolveDrainIfComplete();
    await this.drainPromise;
  }
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) {
    return "/";
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function applyQuery(url: URL, qs: QueryParams): void {
  if (!qs) {
    return;
  }
  for (const [key, rawValue] of Object.entries(qs)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item === undefined || item === null) {
          continue;
        }
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(rawValue));
  }
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

function toFetchUrl(resource: RequestInfo | URL): string {
  if (resource instanceof URL) {
    return resource.toString();
  }
  if (typeof resource === "string") {
    return resource;
  }
  return resource.url;
}

const MATRIX_STATE_AFTER_SYNC_PARAM = "org.matrix.msc4222.use_state_after";

function withoutMatrixStateAfterSyncParam(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (!url.pathname.endsWith("/sync") || !url.searchParams.has(MATRIX_STATE_AFTER_SYNC_PARAM)) {
    return rawUrl;
  }

  url.searchParams.delete(MATRIX_STATE_AFTER_SYNC_PARAM);
  return url.toString();
}

function buildBufferedResponse(params: {
  source: Response;
  body: BodyInit;
  url: string;
}): Response {
  const response = new Response(params.body, {
    status: params.source.status,
    statusText: params.source.statusText,
    headers: new Headers(params.source.headers),
  });
  try {
    Object.defineProperty(response, "url", {
      value: params.source.url || params.url,
      configurable: true,
    });
  } catch {
    // Response.url is read-only in some runtimes; metadata is best-effort only.
  }
  return response;
}

async function enforceDeclaredResponseSize(params: {
  response: Response;
  maxBytes: number;
  createError: (length: number) => Error;
}): Promise<void> {
  const contentLength = params.response.headers.get("content-length");
  if (!contentLength) {
    return;
  }

  let length: number | null;
  try {
    length = parseMediaContentLength(contentLength);
  } catch (error) {
    await params.response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (length === null || length <= params.maxBytes) {
    return;
  }

  const error = params.createError(length);
  await params.response.body?.cancel(error).catch(() => undefined);
  throw error;
}

async function fetchWithMatrixDispatcher(params: {
  url: string;
  init: MatrixDispatcherRequestInit;
}): Promise<Response> {
  // Keep this dispatcher-routing logic local to Matrix transport. Shared SSRF
  // fetches must stay fail-closed unless a retry path can preserve the
  // validated pinned-address binding. Route dispatcher-attached requests
  // through undici runtime fetch so the pinned dispatcher is preserved.
  return await fetchWithRuntimeDispatcherOrMockedGlobal(params.url, params.init);
}

async function fetchWithMatrixGuardedRedirects(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  dispatcherPool: MatrixPinnedDispatcherPool;
}): Promise<{ response: Response; release: () => Promise<void>; finalUrl: string }> {
  let currentUrl = new URL(params.url);
  let method = (params.init?.method ?? "GET").toUpperCase();
  let body = params.init?.body;
  let headers = new Headers(params.init?.headers ?? {});
  const maxRedirects = 5;
  const visited = new Set<string>();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    operation: "matrix.guarded-redirect-fetch",
    url: params.url,
  });

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let release: (() => Promise<void>) | undefined;
    try {
      const pinned = await resolvePinnedHostnameWithPolicy(currentUrl.hostname, {
        policy: params.ssrfPolicy,
      });
      const acquired = await params.dispatcherPool.acquire({
        pinned,
        dispatcherPolicy: params.dispatcherPolicy,
        ssrfPolicy: params.ssrfPolicy,
      });
      release = acquired.release;
      const response = await fetchWithMatrixDispatcher({
        url: currentUrl.toString(),
        init: {
          ...params.init,
          method,
          body,
          headers,
          redirect: "manual",
          signal,
          dispatcher: acquired.dispatcher,
        } as MatrixDispatcherRequestInit,
      });

      if (!isRedirectStatus(response.status)) {
        return {
          response,
          release: async () => {
            cleanup();
            await release?.();
          },
          finalUrl: currentUrl.toString(),
        };
      }

      const location = response.headers.get("location");
      if (!location) {
        cleanup();
        await release?.();
        throw new Error(`Matrix redirect missing location header (${currentUrl.toString()})`);
      }

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== currentUrl.protocol) {
        cleanup();
        await release?.();
        throw new Error(
          `Blocked cross-protocol redirect (${currentUrl.protocol} -> ${nextUrl.protocol})`,
        );
      }

      const nextUrlString = nextUrl.toString();
      if (visited.has(nextUrlString)) {
        cleanup();
        await release?.();
        throw new Error("Redirect loop detected");
      }
      visited.add(nextUrlString);

      if (nextUrl.origin !== currentUrl.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
      }

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method !== "GET" &&
          method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        headers.delete("content-type");
        headers.delete("content-length");
      }

      await response.body?.cancel().catch(() => undefined);
      await release?.();
      currentUrl = nextUrl;
    } catch (error) {
      cleanup();
      await release?.();
      throw error;
    }
  }

  cleanup();
  throw new Error(`Too many redirects while requesting ${params.url}`);
}

export class MatrixTransport {
  private readonly dispatcherPool = new MatrixPinnedDispatcherPool();

  constructor(
    private readonly params: {
      ssrfPolicy?: SsrFPolicy;
      dispatcherPolicy?: PinnedDispatcherPolicy;
    } = {},
  ) {}

  readonly fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    this.dispatcherPool.assertOpen();
    const url = withoutMatrixStateAfterSyncParam(toFetchUrl(resource));
    const { signal, ...requestInit } = init ?? {};
    const { response, release } = await fetchWithMatrixGuardedRedirects({
      url,
      init: requestInit,
      signal: signal ?? undefined,
      ssrfPolicy: this.params.ssrfPolicy,
      dispatcherPolicy: this.params.dispatcherPolicy,
      dispatcherPool: this.dispatcherPool,
    });

    try {
      await enforceDeclaredResponseSize({
        response,
        maxBytes: MATRIX_SDK_RESPONSE_MAX_BYTES,
        createError: (length) =>
          new Error(
            `Matrix SDK response exceeds size limit (${length} bytes > ${MATRIX_SDK_RESPONSE_MAX_BYTES} bytes)`,
          ),
      });
      const body = await readResponseWithLimit(response, MATRIX_SDK_RESPONSE_MAX_BYTES, {
        onOverflow: ({ maxBytes, size }) =>
          new Error(`Matrix SDK response exceeds size limit (${size} bytes > ${maxBytes} bytes)`),
      });
      return buildBufferedResponse({
        source: response,
        body: Uint8Array.from(body),
        url,
      });
    } finally {
      await release();
    }
  }) as typeof fetch;

  async request(
    params: MatrixRequestParams,
  ): Promise<{ response: Response; text: string; buffer: Buffer }> {
    this.dispatcherPool.assertOpen();
    const isAbsoluteEndpoint =
      params.endpoint.startsWith("http://") || params.endpoint.startsWith("https://");
    if (isAbsoluteEndpoint && params.allowAbsoluteEndpoint !== true) {
      throw new Error(
        `Absolute Matrix endpoint is blocked by default: ${params.endpoint}. Set allowAbsoluteEndpoint=true to opt in.`,
      );
    }

    const baseUrl = isAbsoluteEndpoint
      ? new URL(params.endpoint)
      : new URL(`${params.homeserver.replace(/\/+$/u, "")}${normalizeEndpoint(params.endpoint)}`);
    applyQuery(baseUrl, params.qs);

    const headers = new Headers();
    headers.set("Accept", params.raw ? "*/*" : "application/json");
    if (params.accessToken) {
      headers.set("Authorization", `Bearer ${params.accessToken}`);
    }

    let body: BodyInit | undefined;
    if (params.body !== undefined) {
      if (
        params.body instanceof Uint8Array ||
        params.body instanceof ArrayBuffer ||
        typeof params.body === "string"
      ) {
        body = params.body as BodyInit;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(params.body);
      }
    }

    const { response, release } = await fetchWithMatrixGuardedRedirects({
      url: baseUrl.toString(),
      init: {
        method: params.method,
        headers,
        body,
      },
      timeoutMs: params.timeoutMs,
      ssrfPolicy: this.params.ssrfPolicy,
      dispatcherPolicy: this.params.dispatcherPolicy,
      dispatcherPool: this.dispatcherPool,
    });

    try {
      if (params.raw) {
        const rawMaxBytes = params.maxBytes ?? MATRIX_SDK_RESPONSE_MAX_BYTES;
        await enforceDeclaredResponseSize({
          response,
          maxBytes: rawMaxBytes,
          createError: (length) =>
            new MatrixMediaSizeLimitError(
              `Matrix media exceeds configured size limit (${length} bytes > ${rawMaxBytes} bytes)`,
            ),
        });
        const bytes = await readResponseWithLimit(response, rawMaxBytes, {
          onOverflow: ({ maxBytes, size }) =>
            new MatrixMediaSizeLimitError(
              `Matrix media exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`,
            ),
          chunkTimeoutMs: params.readIdleTimeoutMs,
        });
        return {
          response,
          text: bytes.toString("utf8"),
          buffer: bytes,
        };
      }
      const jsonMaxBytes = params.maxBytes ?? MATRIX_JSON_RESPONSE_MAX_BYTES;
      await enforceDeclaredResponseSize({
        response,
        maxBytes: jsonMaxBytes,
        createError: (length) =>
          new Error(
            `Matrix JSON response exceeds configured size limit (${length} bytes > ${jsonMaxBytes} bytes)`,
          ),
      });
      const buffer = await readResponseWithLimit(response, jsonMaxBytes, {
        onOverflow: ({ maxBytes, size }) =>
          new Error(
            `Matrix JSON response exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`,
          ),
        chunkTimeoutMs: params.readIdleTimeoutMs,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`Matrix JSON response stalled: no data received for ${chunkTimeoutMs}ms`),
      });
      return {
        response,
        text: buffer.toString("utf8"),
        buffer,
      };
    } finally {
      await release();
    }
  }

  async close(): Promise<void> {
    // Terminal disposal: callers must create a new Matrix client/transport after shutdown.
    await this.dispatcherPool.close();
  }
}

export function createMatrixTransport(
  params: {
    ssrfPolicy?: SsrFPolicy;
    dispatcherPolicy?: PinnedDispatcherPolicy;
  } = {},
): MatrixTransport {
  return new MatrixTransport(params);
}
