import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Matrix plugin module implements client bootstrap behavior.
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { CoreConfig } from "../types.js";
import { getActiveMatrixClient } from "./active-client.js";
import { isBunRuntime } from "./client/runtime.js";
import type { MatrixSharedClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

type ResolvedRuntimeMatrixClient = {
  client: MatrixClient;
  stopOnDone: boolean;
  cleanup?: (mode: ResolvedRuntimeMatrixClientStopMode) => Promise<void>;
  ensureStarted?: (params?: { abortSignal?: AbortSignal }) => Promise<void>;
};

type MatrixRuntimeClientReadiness = "none" | "prepared" | "started";
type ResolvedRuntimeMatrixClientStopMode = "stop" | "persist" | "discard";

type MatrixResolvedClientHook = (
  client: MatrixClient,
  context: {
    prepareByDefault: boolean;
    ensureStarted?: (params?: { abortSignal?: AbortSignal }) => Promise<void>;
  },
) => Promise<void> | void;

const loadMatrixSharedClientRuntimeDeps = createLazyRuntimeModule(() =>
  Promise.all([import("./client.js"), import("./client/shared.js")]).then(
    ([clientModule, sharedModule]) => ({
      acquireSharedMatrixClient: clientModule.acquireSharedMatrixClient,
      resolveMatrixAuthContext: clientModule.resolveMatrixAuthContext,
      tryAcquireSharedMatrixClientInstance: sharedModule.tryAcquireSharedMatrixClientInstance,
    }),
  ),
);

async function ensureResolvedClientReadiness(params: {
  client: MatrixClient;
  readiness?: MatrixRuntimeClientReadiness;
  prepareByDefault: boolean;
  ensureStarted?: (params?: { abortSignal?: AbortSignal }) => Promise<void>;
}): Promise<void> {
  if (params.readiness === "started") {
    if (params.ensureStarted) {
      await params.ensureStarted();
    } else {
      await params.client.start();
    }
    return;
  }
  if (params.readiness === "prepared" || (!params.readiness && params.prepareByDefault)) {
    await params.client.prepareForOneOff();
  }
}

function ensureMatrixNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

async function resolveRuntimeMatrixClient(opts: {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
  onResolved?: MatrixResolvedClientHook;
}): Promise<ResolvedRuntimeMatrixClient> {
  ensureMatrixNodeRuntime();
  if (opts.client) {
    await opts.onResolved?.(opts.client, { prepareByDefault: false });
    return { client: opts.client, stopOnDone: false };
  }

  if (!opts.cfg) {
    throw new Error(
      "Matrix runtime client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix runtime client") as CoreConfig;
  const {
    acquireSharedMatrixClient,
    resolveMatrixAuthContext,
    tryAcquireSharedMatrixClientInstance,
  } = await loadMatrixSharedClientRuntimeDeps();
  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const active = getActiveMatrixClient(authContext.accountId);
  const activeLease = active ? tryAcquireSharedMatrixClientInstance(active) : null;
  const lease: MatrixSharedClientLease =
    activeLease ??
    (await acquireSharedMatrixClient({
      cfg,
      timeoutMs: opts.timeoutMs,
      accountId: authContext.accountId,
      startClient: false,
    }));
  try {
    await opts.onResolved?.(lease.client, {
      prepareByDefault: lease.prepareByDefault,
      ensureStarted: lease.ensureStarted,
    });
  } catch (err) {
    await lease.release({ mode: "stop" });
    throw err;
  }
  return {
    client: lease.client,
    stopOnDone: true,
    ensureStarted: lease.ensureStarted,
    cleanup: async (mode) => {
      await lease.release({ mode });
    },
  };
}

export async function resolveRuntimeMatrixClientWithReadiness(opts: {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
  readiness?: MatrixRuntimeClientReadiness;
}): Promise<ResolvedRuntimeMatrixClient> {
  return await resolveRuntimeMatrixClient({
    client: opts.client,
    cfg: opts.cfg,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
    onResolved: async (client, context) => {
      await ensureResolvedClientReadiness({
        client,
        readiness: opts.readiness,
        prepareByDefault: context.prepareByDefault,
        ensureStarted: context.ensureStarted,
      });
    },
  });
}

async function stopResolvedRuntimeMatrixClient(
  resolved: ResolvedRuntimeMatrixClient,
  mode: ResolvedRuntimeMatrixClientStopMode = "stop",
): Promise<void> {
  if (!resolved.stopOnDone) {
    return;
  }
  if (resolved.cleanup) {
    await resolved.cleanup(mode);
    return;
  }
  if (mode === "persist") {
    await resolved.client.stopAndPersist();
    return;
  }
  if (mode === "discard") {
    resolved.client.stopWithoutPersist();
    return;
  }
  resolved.client.stop();
}

export async function withResolvedRuntimeMatrixClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
    readiness?: MatrixRuntimeClientReadiness;
  },
  run: (client: MatrixClient) => Promise<T>,
  stopMode: ResolvedRuntimeMatrixClientStopMode = "stop",
): Promise<T> {
  const resolved = await resolveRuntimeMatrixClientWithReadiness(opts);
  try {
    return await run(resolved.client);
  } finally {
    await stopResolvedRuntimeMatrixClient(resolved, stopMode);
  }
}
