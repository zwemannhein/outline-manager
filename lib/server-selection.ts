import type { OutlineServer } from "./types";

/** Keep a valid selection across refreshes, otherwise choose the first server. */
export function resolveServerSelection(
  currentId: string,
  servers: OutlineServer[]
): string {
  if (currentId && servers.some((server) => server.id === currentId)) return currentId;
  return servers[0]?.id ?? "";
}

/** Select the nearest remaining server when the active server is removed. */
export function resolveSelectionAfterRemoval(
  currentId: string,
  removedId: string,
  previousServers: OutlineServer[],
  remainingServers: OutlineServer[]
): string {
  if (currentId !== removedId) return resolveServerSelection(currentId, remainingServers);
  const removedIndex = previousServers.findIndex((server) => server.id === removedId);
  const nextIndex = Math.min(Math.max(removedIndex, 0), remainingServers.length - 1);
  return remainingServers[nextIndex]?.id ?? "";
}
