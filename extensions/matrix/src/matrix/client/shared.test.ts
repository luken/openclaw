// Matrix tests cover shared plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthContextMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

const TEST_CFG = {};

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

let acquireSharedMatrixClient: typeof import("./shared.js").acquireSharedMatrixClient;
let tryAcquireSharedMatrixClientInstance: typeof import("./shared.js").tryAcquireSharedMatrixClientInstance;
let stopSharedClient: typeof import("./shared.js").stopSharedClient;

function authFor(accountId: string): MatrixAuth {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: `@${accountId}:example.org`,
    accessToken: `token-${accountId}`,
    password: "secret", // pragma: allowlist secret
    deviceId: `${accountId.toUpperCase()}-DEVICE`,
    deviceName: `${accountId} device`,
    initialSyncLimit: undefined,
    encryption: false,
  };
}

function createMockClient(name: string) {
  let syncing = false;
  const client = {
    name,
    isSyncing: vi.fn(() => syncing),
    start: vi.fn(async () => {
      syncing = true;
    }),
    stopSyncWithoutPersist: vi.fn(() => {
      syncing = false;
    }),
    stop: vi.fn(() => {
      syncing = false;
    }),
    stopAndPersist: vi.fn(async () => {
      syncing = false;
    }),
    stopWithoutPersist: vi.fn(() => {
      syncing = false;
    }),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
  return client;
}

function primeAccountClientMocks(params?: {
  mainAuth?: MatrixAuth;
  opsAuth?: MatrixAuth;
  mainClient?: ReturnType<typeof createMockClient>;
  opsClient?: ReturnType<typeof createMockClient>;
}) {
  const mainAuth = params?.mainAuth ?? authFor("main");
  const opsAuth = params?.opsAuth ?? authFor("ops");
  const mainClient = params?.mainClient ?? createMockClient("main");
  const opsClient = params?.opsClient ?? createMockClient("ops");

  resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
    accountId === "ops" ? opsAuth : mainAuth,
  );
  createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
    accountId === "ops" ? opsClient : mainClient,
  );

  return { mainClient, opsClient };
}

function createPendingSharedStartup(mainAuth = authFor("main")) {
  let resolveStartup: (() => void) | undefined;
  let syncing = false;
  const mainClient = {
    ...createMockClient("main"),
    isSyncing: vi.fn(() => syncing),
    start: vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          resolveStartup = () => {
            syncing = true;
            resolve();
          };
        }),
    ),
  };

  resolveMatrixAuthMock.mockResolvedValue(mainAuth);
  createMatrixClientMock.mockResolvedValue(mainClient);
  return { mainClient, resolveStartup: () => resolveStartup?.() };
}

async function expectMatrixStartupAbort(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AbortError",
    message: "Matrix startup aborted",
  });
}

describe("shared Matrix client leases", () => {
  beforeAll(async () => {
    ({ acquireSharedMatrixClient, tryAcquireSharedMatrixClientInstance, stopSharedClient } =
      await import("./shared.js"));
  });

  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    resolveMatrixAuthContextMock.mockReset();
    createMatrixClientMock.mockReset();
    resolveMatrixAuthContextMock.mockImplementation(
      ({ accountId }: { accountId?: string | null } = {}) => ({
        cfg: TEST_CFG,
        env: undefined,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
  });

  afterEach(() => {
    stopSharedClient();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps account clients isolated while reusing each account state", async () => {
    const { mainClient, opsClient } = primeAccountClientMocks();
    const mainOwner = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    const opsOwner = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "ops",
      startClient: false,
    });
    const mainBorrower = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(mainOwner.client).toBe(mainClient);
    expect(mainBorrower.client).toBe(mainClient);
    expect(opsOwner.client).toBe(opsClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);

    await mainBorrower.release();
    await mainOwner.release();
    await opsOwner.release();
  });

  it("uses the effective implicit account key", async () => {
    const opsAuth = authFor("ops");
    const opsClient = createMockClient("ops");
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: TEST_CFG,
      env: undefined,
      accountId: "ops",
      resolved: {},
    });
    resolveMatrixAuthMock.mockResolvedValue(opsAuth);
    createMatrixClientMock.mockResolvedValue(opsClient);

    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const borrower = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    expect(owner.client).toBe(opsClient);
    expect(borrower.client).toBe(opsClient);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    await borrower.release();
    await owner.release();
  });

  it("honors startClient false and exposes explicit preparation behavior", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);

    const lease = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(lease.client).toBe(mainClient);
    expect(lease.prepareByDefault).toBe(true);
    expect(mainClient.start).not.toHaveBeenCalled();
    await lease.release();
  });

  it("keeps the owner alive until its final borrower releases", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const borrower = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    let ownerSettled = false;
    const ownerRelease = owner.release({ mode: "persist" }).then((result) => {
      ownerSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(ownerSettled).toBe(false);
    expect(mainClient.stopAndPersist).not.toHaveBeenCalled();

    await borrower.release({ mode: "discard" });
    await expect(ownerRelease).resolves.toEqual({ terminal: true, forced: false });
    expect(mainClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(mainClient.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("makes each lease release idempotent", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const borrower = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    const firstRelease = borrower.release();
    const secondRelease = borrower.release({ mode: "discard" });
    await expect(firstRelease).resolves.toEqual({ terminal: false, forced: false });
    await expect(secondRelease).resolves.toEqual({ terminal: false, forced: false });
    await owner.release();
    expect(mainClient.stop).toHaveBeenCalledOnce();
  });

  it("lets the owner explicitly discard temporary state", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    await owner.release({ mode: "discard" });

    expect(mainClient.stopWithoutPersist).toHaveBeenCalledOnce();
    expect(mainClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("forces a timed-out owner drain without persistence", async () => {
    vi.useFakeTimers();
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const borrower = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const beforeStop = vi.fn();

    const release = owner.release({ mode: "persist", beforeStop });
    await vi.advanceTimersByTimeAsync(2_001);

    await expect(release).resolves.toEqual({ terminal: true, forced: true });
    expect(mainClient.stopWithoutPersist).toHaveBeenCalledOnce();
    expect(mainClient.stopAndPersist).not.toHaveBeenCalled();
    expect(beforeStop).toHaveBeenCalledWith({ forced: true });
    await borrower.release();
  });

  it("leases an active instance without resolving auth and ignores borrower shutdown mode", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    resolveMatrixAuthMock.mockClear();

    const borrower = tryAcquireSharedMatrixClientInstance(mainClient as unknown as MatrixClient);
    expect(borrower?.prepareByDefault).toBe(false);
    expect(resolveMatrixAuthMock).not.toHaveBeenCalled();

    const ownerRelease = owner.release({ mode: "persist" });
    await borrower?.release({ mode: "discard" });
    await ownerRelease;
    expect(mainClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(mainClient.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("uses the client as the authoritative sync-state source", async () => {
    const mainClient = createMockClient("main");
    resolveMatrixAuthMock.mockResolvedValue(authFor("main"));
    createMatrixClientMock.mockResolvedValue(mainClient);
    const owner = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    await owner.ensureStarted();
    mainClient.stopSyncWithoutPersist();
    await owner.ensureStarted();

    expect(mainClient.start).toHaveBeenCalledTimes(2);
    await owner.release();
  });

  it("rejects mismatched explicit account ids", async () => {
    await expect(
      acquireSharedMatrixClient({
        auth: authFor("ops"),
        accountId: "main",
        startClient: false,
      }),
    ).rejects.toThrow("Matrix shared client account mismatch");
  });

  it("lets a later waiter abort while shared startup continues for the owner", async () => {
    const { mainClient, resolveStartup } = createPendingSharedStartup();
    const ownerPromise = acquireSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    await vi.waitFor(() => expect(mainClient.start).toHaveBeenCalledOnce());

    const abortController = new AbortController();
    const canceledWaiter = acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expectMatrixStartupAbort(canceledWaiter);

    resolveStartup();
    const owner = await ownerPromise;
    expect(owner.client).toBe(mainClient);
    await owner.release();
  });

  it("keeps the startup lock while an aborted waiter exits", async () => {
    const { mainClient, resolveStartup } = createPendingSharedStartup();
    const ownerPromise = acquireSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    await vi.waitFor(() => expect(mainClient.start).toHaveBeenCalledOnce());

    const abortController = new AbortController();
    const abortedWaiter = acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expectMatrixStartupAbort(abortedWaiter);

    const followerPromise = acquireSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    expect(mainClient.start).toHaveBeenCalledOnce();
    resolveStartup();

    const [owner, follower] = await Promise.all([ownerPromise, followerPromise]);
    expect(mainClient.start).toHaveBeenCalledOnce();
    await follower.release();
    await owner.release();
  });

  it("creates a distinct client when dispatcher policy changes", async () => {
    const firstAuth = {
      ...authFor("main"),
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: "http://127.0.0.1:7890",
      },
    };
    const secondAuth = {
      ...authFor("main"),
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: "http://127.0.0.1:7891",
      },
    };
    const firstClient = createMockClient("main-first");
    const secondClient = createMockClient("main-second");
    resolveMatrixAuthMock.mockResolvedValueOnce(firstAuth).mockResolvedValueOnce(secondAuth);
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    const first = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const second = await acquireSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    expect(first.client).toBe(firstClient);
    expect(second.client).toBe(secondClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await first.release();
    await second.release();
  });
});
