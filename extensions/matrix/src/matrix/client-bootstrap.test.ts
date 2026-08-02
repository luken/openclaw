// Matrix tests cover client bootstrap plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  createMockMatrixClientLease,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "./client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  acquireSharedMatrixClientMock,
  tryAcquireSharedMatrixClientInstanceMock,
  sharedClientLeaseReleaseMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("./active-client.js", () => ({
  getActiveMatrixClient: (...args: unknown[]) => getActiveMatrixClientMock(...args),
}));

vi.mock("./client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("./client/shared.js", () => ({
  tryAcquireSharedMatrixClientInstance: (...args: [import("./sdk.js").MatrixClient]) =>
    tryAcquireSharedMatrixClientInstanceMock(...args),
}));

let resolveRuntimeMatrixClientWithReadiness: typeof import("./client-bootstrap.js").resolveRuntimeMatrixClientWithReadiness;
let withResolvedRuntimeMatrixClient: typeof import("./client-bootstrap.js").withResolvedRuntimeMatrixClient;

describe("client bootstrap", () => {
  beforeAll(async () => {
    ({ resolveRuntimeMatrixClientWithReadiness, withResolvedRuntimeMatrixClient } =
      await import("./client-bootstrap.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks({ resolved: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("releases leased shared clients when readiness setup fails", async () => {
    const sharedClient = createMockMatrixClient();
    vi.mocked(sharedClient["prepareForOneOff"]).mockRejectedValue(new Error("prepare failed"));
    acquireSharedMatrixClientMock.mockResolvedValue(createMockMatrixClientLease(sharedClient));

    await expect(
      resolveRuntimeMatrixClientWithReadiness({
        cfg: TEST_CFG,
        accountId: "default",
        readiness: "prepared",
      }),
    ).rejects.toThrow("prepare failed");

    expect(sharedClientLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("releases leased shared clients when the wrapped action throws during readiness", async () => {
    const sharedClient = createMockMatrixClient();
    vi.mocked(sharedClient["start"]).mockRejectedValue(new Error("start failed"));
    acquireSharedMatrixClientMock.mockResolvedValue(createMockMatrixClientLease(sharedClient));

    await expect(
      withResolvedRuntimeMatrixClient(
        {
          cfg: TEST_CFG,
          accountId: "default",
          readiness: "started",
        },
        async () => "ok",
      ),
    ).rejects.toThrow("start failed");

    expect(sharedClientLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("leases an active monitor client for the full wrapped operation", async () => {
    const activeClient = createMockMatrixClient();
    const activeLease = createMockMatrixClientLease(activeClient, {
      prepareByDefault: false,
      owner: false,
    });
    getActiveMatrixClientMock.mockReturnValue(activeClient);
    tryAcquireSharedMatrixClientInstanceMock.mockReturnValue(activeLease);

    await expect(
      withResolvedRuntimeMatrixClient(
        {
          cfg: TEST_CFG,
          accountId: "default",
        },
        async (client) => {
          expect(client).toBe(activeClient);
          expect(activeLease.release).not.toHaveBeenCalled();
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(tryAcquireSharedMatrixClientInstanceMock).toHaveBeenCalledWith(activeClient);
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeLease.release).toHaveBeenCalledWith({ mode: "stop" });
  });
});
