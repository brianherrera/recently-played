import type { Platform, PlayedGame, PublicOutput, State, TrackedGame } from "./types";

export const emptyState = (now: string): State => ({
  stateVersion: 1,
  updatedAt: now,
  platforms: {},
  games: {},
});

export const gameId = (platform: Platform, platformGameId: string): string =>
  `${platform}:${platformGameId}`;

/**
 * Merge freshly fetched games into state. Never removes games: a game that a
 * platform stops reporting (e.g. outside Steam's window) keeps its last known data.
 * lastPlayed only moves forward, so a flaky response can't push a game backwards.
 */
export function mergeGames(state: State, games: PlayedGame[], now: string): State {
  const next: Record<string, TrackedGame> = { ...state.games };
  for (const g of games) {
    const id = gameId(g.platform, g.platformGameId);
    const existing = next[id];
    if (!existing) {
      next[id] = {
        id,
        platform: g.platform,
        platformGameId: g.platformGameId,
        title: g.title,
        lastPlayed: g.lastPlayed,
        firstSeen: now,
        coverSourceUrl: g.coverSourceUrl,
      };
      continue;
    }
    const newer = Date.parse(g.lastPlayed) > Date.parse(existing.lastPlayed);
    next[id] = {
      ...existing,
      title: g.title || existing.title,
      lastPlayed: newer ? g.lastPlayed : existing.lastPlayed,
      coverSourceUrl: g.coverSourceUrl ?? existing.coverSourceUrl,
    };
  }
  return { ...state, games: next };
}

/** Most recently played first; ties broken by id for stable output. */
export function topGames(state: State, limit: number): TrackedGame[] {
  return Object.values(state.games)
    .sort((a, b) => Date.parse(b.lastPlayed) - Date.parse(a.lastPlayed) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function buildPublicOutput(
  state: State,
  top: TrackedGame[],
  now: string,
  publicBaseUrl: string,
): PublicOutput {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const platforms: PublicOutput["platforms"] = {};
  for (const [p, status] of Object.entries(state.platforms)) {
    platforms[p as Platform] = { lastSuccess: status?.lastSuccess };
  }
  return {
    schemaVersion: 1,
    generatedAt: now,
    platforms,
    games: top.map((g) => ({
      id: g.id,
      platform: g.platform,
      title: g.title,
      lastPlayed: g.lastPlayed,
      ...(g.coverKey ? { coverUrl: `${base}/${g.coverKey}` } : {}),
    })),
  };
}
