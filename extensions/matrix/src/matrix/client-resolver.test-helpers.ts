// Matrix helper module supports client resolver helpers behavior.
import { expect, vi, type Mock } from "vitest";
import type { MatrixSharedClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

type MatrixClientResolverMocks = {
  loadConfigMock: Mock<() => unknown>;
  getMatrixRuntimeMock: Mock<() => unknown>;
  getActiveMatrixClientMock: Mock<(...args: unknown[]) => MatrixClient | null>;
  acquireSharedMatrixClientMock: Mock<(...args: unknown[]) => Promise<MatrixSharedClientLease>>;
  tryAcquireSharedMatrixClientInstanceMock: Mock<
    (client: MatrixClient) => MatrixSharedClientLease | null
  >;
  sharedClientLeaseReleaseMock: Mock<MatrixSharedClientLease["release"]>;
  isBunRuntimeMock: Mock<() => boolean>;
  resolveMatrixAuthContextMock: Mock<
    (params: { cfg: unknown; accountId?: string | null }) => unknown
  >;
};

export const matrixClientResolverMocks: MatrixClientResolverMocks = {
  loadConfigMock: vi.fn(() => ({})),
  getMatrixRuntimeMock: vi.fn(),
  getActiveMatrixClientMock: vi.fn(),
  acquireSharedMatrixClientMock: vi.fn(),
  tryAcquireSharedMatrixClientInstanceMock: vi.fn(),
  sharedClientLeaseReleaseMock: vi.fn(),
  isBunRuntimeMock: vi.fn(() => false),
  resolveMatrixAuthContextMock: vi.fn(),
};

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => {
      if (cfg) {
        return cfg;
      }
      return matrixClientResolverMocks.loadConfigMock();
    }),
  };
});

export function createMockMatrixClient(): MatrixClient {
  return {
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
    stopWithoutPersist: vi.fn(() => undefined),
  } as unknown as MatrixClient;
}

export function createMockMatrixClientLease(
  client: MatrixClient,
  params: { prepareByDefault?: boolean; owner?: boolean } = {},
): MatrixSharedClientLease {
  const release =
    params.owner === false ? vi.fn() : matrixClientResolverMocks.sharedClientLeaseReleaseMock;
  release.mockResolvedValue({ terminal: params.owner !== false, forced: false });
  return {
    client,
    owner: params.owner !== false,
    prepareByDefault: params.prepareByDefault ?? true,
    ensureStarted: vi.fn(async () => {
      await client.start();
    }),
    release,
  };
}

export function primeMatrixClientResolverMocks(params?: {
  cfg?: unknown;
  accountId?: string;
  resolved?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  client?: MatrixClient;
}): MatrixClient {
  const {
    loadConfigMock,
    getMatrixRuntimeMock,
    getActiveMatrixClientMock,
    acquireSharedMatrixClientMock,
    tryAcquireSharedMatrixClientInstanceMock,
    sharedClientLeaseReleaseMock,
    isBunRuntimeMock,
    resolveMatrixAuthContextMock,
  } = matrixClientResolverMocks;

  const cfg = params?.cfg ?? {};
  const accountId = params?.accountId ?? "default";
  const defaultResolved = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    password: undefined,
    deviceId: "DEVICE123",
    encryption: false,
  };
  const client = params?.client ?? createMockMatrixClient();

  vi.clearAllMocks();
  loadConfigMock.mockReturnValue(cfg);
  getMatrixRuntimeMock.mockReturnValue({
    config: {
      current: loadConfigMock,
    },
  });
  getActiveMatrixClientMock.mockReturnValue(null);
  tryAcquireSharedMatrixClientInstanceMock.mockReturnValue(null);
  isBunRuntimeMock.mockReturnValue(false);
  sharedClientLeaseReleaseMock.mockReset().mockResolvedValue({ terminal: true, forced: false });
  resolveMatrixAuthContextMock.mockImplementation(
    ({
      cfg: explicitCfg,
      accountId: explicitAccountId,
    }: {
      cfg: unknown;
      accountId?: string | null;
    }) => ({
      cfg: explicitCfg,
      env: process.env,
      accountId: explicitAccountId ?? accountId,
      resolved: {
        ...defaultResolved,
        ...params?.resolved,
      },
    }),
  );
  acquireSharedMatrixClientMock.mockResolvedValue(createMockMatrixClientLease(client));

  return client;
}

export async function expectOneOffSharedMatrixClient(params?: {
  cfg?: unknown;
  accountId?: string;
  timeoutMs?: number;
  prepareForOneOffCalls?: number;
  startCalls?: number;
  releaseMode?: "persist" | "stop" | "discard";
}) {
  const { getActiveMatrixClientMock, acquireSharedMatrixClientMock, sharedClientLeaseReleaseMock } =
    matrixClientResolverMocks;
  const accountId = params?.accountId ?? "default";
  const prepareForOneOffCalls = params?.prepareForOneOffCalls ?? 1;
  const startCalls = params?.startCalls ?? 0;
  const releaseMode = params?.releaseMode ?? "stop";

  expect(getActiveMatrixClientMock).toHaveBeenCalledWith(accountId);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledTimes(1);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params?.cfg ?? {},
    timeoutMs: params?.timeoutMs,
    accountId,
    startClient: false,
  });

  const lease = await acquireSharedMatrixClientMock.mock.results[0]!.value;
  const sharedClient = lease.client;
  expect(sharedClient.prepareForOneOff).toHaveBeenCalledTimes(prepareForOneOffCalls);
  expect(sharedClient.start).toHaveBeenCalledTimes(startCalls);
  expect(sharedClientLeaseReleaseMock).toHaveBeenCalledWith({ mode: releaseMode });

  return sharedClient;
}

export function expectExplicitMatrixClientConfig(params: { cfg: unknown; accountId?: string }) {
  const { getMatrixRuntimeMock, resolveMatrixAuthContextMock, acquireSharedMatrixClientMock } =
    matrixClientResolverMocks;
  const accountId = params.accountId ?? "default";

  expect(getMatrixRuntimeMock).not.toHaveBeenCalled();
  expect(resolveMatrixAuthContextMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    accountId,
  });
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    timeoutMs: undefined,
    accountId,
    startClient: false,
  });
}
