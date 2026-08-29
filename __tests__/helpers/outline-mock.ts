/**
 * Shared vi.mock factory for lib/outline-admin, backed by the FakeOutline double.
 *
 * Extracted so every VPN-core test suite mocks the Outline client identically —
 * divergent mocks between suites would let a bug hide in one of them.
 */

import { fakeOutline } from "./fake-outline";

export class MockOutlineApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = "OutlineApiError";
  }
}

export function buildOutlineAdminMock() {
  const fo = fakeOutline;

  return {
    OutlineApiError: MockOutlineApiError,

    listRegisteredServers: async () => fo.servers,

    resolveServer: async (id: string) => {
      const s = fo.servers.find((x) => x.id === id);
      if (!s) throw new MockOutlineApiError("Server is not registered", 404, "NOT_FOUND");
      return s;
    },

    listAccessKeys: async (serverId: string) => fo.listKeys(serverId),

    getAccessKey: async (serverId: string, keyId: string) => fo.getKey(serverId, keyId) ?? null,

    accessKeyExists: async (serverId: string, keyId: string) =>
      fo.getKey(serverId, keyId) !== undefined,

    createAccessKey: async (serverId: string, name?: string) => {
      const key = (await fo.request(serverId, "POST", "/access-keys")) as {
        id: string;
        accessUrl: string;
        name: string;
      };
      if (name) {
        await fo.request(serverId, "PUT", `/access-keys/${key.id}/name`, { name });
        key.name = name;
      }
      return key;
    },

    renameAccessKey: async (serverId: string, keyId: string, name: string) => {
      await fo.request(serverId, "PUT", `/access-keys/${keyId}/name`, { name });
    },

    deleteAccessKey: async (serverId: string, keyId: string) => {
      await fo.request(serverId, "DELETE", `/access-keys/${keyId}`);
    },

    setDataLimit: async (serverId: string, keyId: string, bytes: number) => {
      await fo.request(serverId, "PUT", `/access-keys/${keyId}/data-limit`, {
        limit: { bytes },
      });
    },

    removeDataLimit: async (serverId: string, keyId: string) => {
      await fo.request(serverId, "DELETE", `/access-keys/${keyId}/data-limit`);
    },

    applyDataLimit: async (serverId: string, keyId: string, bytes: number | null) => {
      if (bytes === null) {
        await fo.request(serverId, "DELETE", `/access-keys/${keyId}/data-limit`);
      } else {
        await fo.request(serverId, "PUT", `/access-keys/${keyId}/data-limit`, {
          limit: { bytes: Math.max(0, Math.floor(bytes)) },
        });
      }
    },

    getKeyLimitBytes: async (serverId: string, keyId: string) =>
      fo.getKey(serverId, keyId)?.dataLimit?.bytes ?? null,

    getTransferMetrics: async (serverId: string) =>
      fo.request(serverId, "GET", "/metrics/transfer"),

    getKeyUsageBytes: async (serverId: string, keyId: string) => {
      const m = (await fo.request(serverId, "GET", "/metrics/transfer")) as {
        bytesTransferredByUserId: Record<string, number>;
      };
      return m.bytesTransferredByUserId[keyId] ?? 0;
    },

    getServerInfo: async (serverId: string) => fo.request(serverId, "GET", "/server"),

    outlineRequest: async (
      server: { id: string },
      method: string,
      path: string,
      body?: unknown
    ) => fo.request(server.id, method, path, body),

    callServer: async (serverId: string, method: string, path: string, body?: unknown) =>
      fo.request(serverId, method, path, body),
  };
}

/**
 * KV mock that records writes, so tests can assert the free-tier property that
 * cycle rollover costs ZERO Cloudflare KV writes.
 */
export function buildKvMock() {
  const state = {
    writes: [] as Array<{ token: string; rev: number }>,
    deletes: [] as string[],
    dirty: new Set<string>(),
    /** When true, every projection write fails, simulating a KV outage. */
    failWrites: false,
    /** Revision the edge currently reports, for the cleanup interlock. */
    kvRev: new Map<string, number>(),
  };

  const mock = {
    __state: state,

    putDynamicProjection: async (
      record: { token: string; rev: number },
      _options?: { force?: boolean }
    ) => {
      if (state.failWrites) {
        state.dirty.add(record.token);
        return { ok: false as const, reason: "http_error" as const };
      }
      state.writes.push({ token: record.token, rev: record.rev });
      state.kvRev.set(record.token, record.rev);
      state.dirty.delete(record.token);
      return { ok: true as const };
    },

    syncDynamicToken: async (token: string, _options?: { force?: boolean }) => {
      if (state.failWrites) {
        state.dirty.add(token);
        return { ok: false as const, reason: "http_error" as const };
      }
      state.writes.push({ token, rev: -1 });
      state.dirty.delete(token);
      return { ok: true as const };
    },

    deleteDynamicProjection: async (token: string) => {
      state.deletes.push(token);
      state.kvRev.delete(token);
      return { ok: true as const };
    },

    markDynamicDirty: async (token: string) => {
      state.dirty.add(token);
    },

    listDirtyTokens: async () => Array.from(state.dirty),
    countDirtyTokens: async () => state.dirty.size,

    drainDirtyDynamicRecords: async () => ({
      attempted: state.dirty.size,
      synced: 0,
      deleted: 0,
      failed: 0,
      remaining: state.dirty.size,
    }),

    getWriteBudget: async () => ({
      used: state.writes.length,
      limit: 1000,
      remaining: 1000 - state.writes.length,
      warn: false,
    }),

    getSyncState: async () => "synced" as const,

    isKvConfigured: () => true,
    getKvConfig: () => ({ accountId: "a", namespaceId: "n", apiToken: "t" }),

    kvGetProjection: async (token: string) => {
      const rev = state.kvRev.get(token);
      return rev === undefined ? null : { accessUrl: "ss://x", status: "active", rev, updatedAt: "" };
    },

    /** The migration-cleanup interlock. */
    verifyProjectionCurrent: async (record: { token: string; rev: number }) => {
      const kvRev = state.kvRev.get(record.token) ?? null;
      return { current: kvRev !== null && kvRev >= record.rev, kvRev };
    },

    projectionKey: (token: string) => `dyn:${token}`,
  };

  return mock;
}
