// Matrix plugin module implements shared behavior.
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { LogService } from "../sdk/logger.js";
import { awaitMatrixStartupWithAbort } from "../startup-abort.js";
import { resolveMatrixAuth, resolveMatrixAuthContext } from "./config.js";
import type { MatrixAuth } from "./types.js";

const loadMatrixCreateClientDeps = createLazyRuntimeModule(() =>
  import("./create-client.js").then((runtime) => ({
    createMatrixClient: runtime.createMatrixClient,
  })),
);

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  encryption: boolean;
  cryptoReady: boolean;
  startPromise: Promise<void> | null;
  leases: number;
  acceptingLeases: boolean;
  drainWaiters: Set<() => void>;
  finalizePromise: Promise<void> | null;
};

export type MatrixSharedClientReleaseMode = "stop" | "persist" | "discard";

export type MatrixSharedClientLeaseReleaseOptions = {
  mode?: MatrixSharedClientReleaseMode;
  beforeStop?: (params: { forced: boolean }) => Promise<void> | void;
};

export type MatrixSharedClientLeaseReleaseResult = {
  terminal: boolean;
  forced: boolean;
};

export type MatrixSharedClientLease = {
  client: MatrixClient;
  owner: boolean;
  prepareByDefault: boolean;
  ensureStarted: (params?: { abortSignal?: AbortSignal }) => Promise<void>;
  release: (
    options?: MatrixSharedClientLeaseReleaseOptions,
  ) => Promise<MatrixSharedClientLeaseReleaseResult>;
};

const MATRIX_SHARED_CLIENT_DRAIN_TIMEOUT_MS = 2_000;

const sharedClientStates = new Map<string, SharedMatrixClientState>();
const sharedClientPromises = new Map<string, Promise<SharedMatrixClientState>>();
const sharedClientStatesByInstance = new WeakMap<MatrixClient, SharedMatrixClientState>();
const allSharedClientStates = new Set<SharedMatrixClientState>();

function serializeDispatcherPolicyKey(auth: MatrixAuth): string {
  return JSON.stringify(auth.dispatcherPolicy ?? null);
}

function buildSharedClientKey(auth: MatrixAuth): string {
  return [
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    auth.allowPrivateNetwork ? "private-net" : "strict-net",
    serializeDispatcherPolicyKey(auth),
    auth.accountId,
  ].join("|");
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
}): Promise<SharedMatrixClientState> {
  const { createMatrixClient } = await loadMatrixCreateClientDeps();
  const client = await createMatrixClient({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    password: params.auth.password,
    deviceId: params.auth.deviceId,
    encryption: params.auth.encryption,
    localTimeoutMs: params.timeoutMs,
    initialSyncLimit: params.auth.initialSyncLimit,
    accountId: params.auth.accountId,
    allowPrivateNetwork: params.auth.allowPrivateNetwork,
    ssrfPolicy: params.auth.ssrfPolicy,
    dispatcherPolicy: params.auth.dispatcherPolicy,
  });
  return {
    client,
    key: buildSharedClientKey(params.auth),
    encryption: params.auth.encryption === true,
    cryptoReady: false,
    startPromise: null,
    leases: 0,
    acceptingLeases: true,
    drainWaiters: new Set(),
    finalizePromise: null,
  };
}

function retireSharedClientState(state: SharedMatrixClientState): void {
  state.acceptingLeases = false;
  if (sharedClientStates.get(state.key) === state) {
    sharedClientStates.delete(state.key);
  }
}

function finishSharedClientState(state: SharedMatrixClientState): void {
  retireSharedClientState(state);
  sharedClientStatesByInstance.delete(state.client);
  allSharedClientStates.delete(state);
}

function notifySharedClientDrain(state: SharedMatrixClientState): void {
  if (state.leases !== 0) {
    return;
  }
  for (const resolve of state.drainWaiters) {
    resolve();
  }
  state.drainWaiters.clear();
}

async function waitForSharedClientDrain(state: SharedMatrixClientState): Promise<boolean> {
  if (state.leases === 0) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveDrain: (() => void) | undefined;
  const drained = await Promise.race([
    new Promise<true>((resolve) => {
      resolveDrain = () => resolve(true);
      state.drainWaiters.add(resolveDrain);
    }),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), MATRIX_SHARED_CLIENT_DRAIN_TIMEOUT_MS);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (resolveDrain) {
    state.drainWaiters.delete(resolveDrain);
  }
  return drained;
}

async function finalizeSharedClientState(params: {
  state: SharedMatrixClientState;
  mode: MatrixSharedClientReleaseMode;
  forced: boolean;
  beforeStop?: MatrixSharedClientLeaseReleaseOptions["beforeStop"];
}): Promise<void> {
  const { state } = params;
  if (!state.finalizePromise) {
    state.finalizePromise = (async () => {
      let beforeStopError: unknown;
      try {
        await params.beforeStop?.({ forced: params.forced });
      } catch (error) {
        beforeStopError = error;
      }

      const mode = params.forced || beforeStopError ? "discard" : params.mode;
      try {
        if (mode === "persist") {
          await state.client.stopAndPersist();
        } else if (mode === "discard") {
          state.client.stopWithoutPersist();
        } else {
          state.client.stop();
        }
      } finally {
        finishSharedClientState(state);
      }
      if (beforeStopError) {
        throw beforeStopError;
      }
    })();
  }
  await state.finalizePromise;
}

async function ensureSharedClientStarted(params: {
  state: SharedMatrixClientState;
  encryption?: boolean;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const waitForStart = async (startPromise: Promise<void>) => {
    await awaitMatrixStartupWithAbort(startPromise, params.abortSignal);
  };

  if (params.state.client.isSyncing()) {
    return;
  }
  if (params.state.startPromise) {
    await waitForStart(params.state.startPromise);
    return;
  }

  const startPromise = (async () => {
    const client = params.state.client;

    // Initialize crypto if enabled
    if (params.encryption && !params.state.cryptoReady) {
      try {
        const joinedRooms = await client.getJoinedRooms();
        if (client.crypto) {
          await client.crypto.prepare(joinedRooms);
          params.state.cryptoReady = true;
        }
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
      }
    }

    await client.start({ abortSignal: params.abortSignal });
  })();
  // Keep the shared startup lock until the underlying start fully settles, even
  // if one waiter aborts early while another caller still owns the startup.
  const guardedStart = startPromise.finally(() => {
    if (params.state.startPromise === guardedStart) {
      params.state.startPromise = null;
    }
  });
  params.state.startPromise = guardedStart;

  await waitForStart(guardedStart);
}

async function resolveSharedMatrixClientState(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    accountId?: string | null;
    forceNew?: boolean;
  } = {},
): Promise<{ state: SharedMatrixClientState; created: boolean }> {
  const requestedAccountId = normalizeOptionalAccountId(params.accountId);
  if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) {
    throw new Error(
      `Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const authContext = (() => {
    if (params.auth) {
      return null;
    }
    if (!params.cfg) {
      throw new Error(
        "Matrix shared client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
      );
    }
    return resolveMatrixAuthContext({
      cfg: params.cfg,
      env: params.env,
      accountId: params.accountId,
    });
  })();
  const auth =
    params.auth ??
    (await resolveMatrixAuth({
      cfg: authContext?.cfg ?? params.cfg,
      env: authContext?.env ?? params.env,
      accountId: authContext?.accountId,
    }));
  const key = buildSharedClientKey(auth);

  const existingState = sharedClientStates.get(key);
  if (existingState && !params.forceNew && existingState.acceptingLeases) {
    return { state: existingState, created: false };
  }
  if (existingState && params.forceNew) {
    retireSharedClientState(existingState);
  }

  const existingPromise = sharedClientPromises.get(key);
  if (existingPromise) {
    const pending = await existingPromise;
    if (!params.forceNew && pending.acceptingLeases) {
      return { state: pending, created: false };
    }
    retireSharedClientState(pending);
  }

  const creationPromise = createSharedMatrixClient({
    auth,
    timeoutMs: params.timeoutMs,
  });
  sharedClientPromises.set(key, creationPromise);

  try {
    const created = await creationPromise;
    sharedClientStates.set(key, created);
    sharedClientStatesByInstance.set(created.client, created);
    allSharedClientStates.add(created);
    return { state: created, created: true };
  } finally {
    if (sharedClientPromises.get(key) === creationPromise) {
      sharedClientPromises.delete(key);
    }
  }
}

function createSharedMatrixClientLease(params: {
  state: SharedMatrixClientState;
  owner: boolean;
  prepareByDefault: boolean;
}): MatrixSharedClientLease | null {
  if (!params.state.acceptingLeases) {
    return null;
  }
  params.state.leases += 1;
  let releasePromise: Promise<MatrixSharedClientLeaseReleaseResult> | null = null;

  return {
    client: params.state.client,
    owner: params.owner,
    prepareByDefault: params.prepareByDefault,
    ensureStarted: async ({ abortSignal } = {}) => {
      await ensureSharedClientStarted({
        state: params.state,
        encryption: params.state.encryption,
        abortSignal,
      });
    },
    release: (options = {}) => {
      if (releasePromise) {
        return releasePromise;
      }
      releasePromise = (async () => {
        if (params.owner) {
          retireSharedClientState(params.state);
        }
        params.state.leases -= 1;
        notifySharedClientDrain(params.state);

        if (!params.owner) {
          return { terminal: false, forced: false };
        }

        const drained = await waitForSharedClientDrain(params.state);
        if (!drained) {
          LogService.warn(
            "MatrixClientLite",
            "Matrix shared client drain timed out; forcing terminal shutdown without persistence",
          );
        }
        await finalizeSharedClientState({
          state: params.state,
          mode: options.mode ?? "stop",
          forced: !drained,
          beforeStop: options.beforeStop,
        });
        return { terminal: true, forced: !drained };
      })();
      return releasePromise;
    },
  };
}

export async function acquireSharedMatrixClient(
  params: {
    cfg?: CoreConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    auth?: MatrixAuth;
    startClient?: boolean;
    accountId?: string | null;
    abortSignal?: AbortSignal;
    ownership?: "auto" | "owner";
  } = {},
): Promise<MatrixSharedClientLease> {
  let forceNew = params.ownership === "owner";
  for (;;) {
    const { state, created } = await resolveSharedMatrixClientState({
      cfg: params.cfg,
      env: params.env,
      timeoutMs: params.timeoutMs,
      auth: params.auth,
      accountId: params.accountId,
      forceNew,
    });
    forceNew = false;
    const lease = createSharedMatrixClientLease({
      state,
      owner: created,
      prepareByDefault: true,
    });
    if (!lease) {
      continue;
    }
    if (params.startClient !== false) {
      try {
        await lease.ensureStarted({ abortSignal: params.abortSignal });
      } catch (error) {
        await lease.release({ mode: "stop" });
        throw error;
      }
    }
    return lease;
  }
}

export function tryAcquireSharedMatrixClientInstance(
  client: MatrixClient,
): MatrixSharedClientLease | null {
  const state = sharedClientStatesByInstance.get(client);
  if (!state) {
    return null;
  }
  return createSharedMatrixClientLease({
    state,
    owner: false,
    prepareByDefault: false,
  });
}

export function stopSharedClient(): void {
  for (const state of allSharedClientStates) {
    retireSharedClientState(state);
    state.client.stop();
    state.finalizePromise = Promise.resolve();
    finishSharedClientState(state);
  }
  sharedClientStates.clear();
  sharedClientPromises.clear();
}
