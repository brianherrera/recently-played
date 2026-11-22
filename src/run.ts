import { ensureCovers } from "./covers";
import type { CredentialStore, Credentials } from "./credentials";
import { emitMetric } from "./metrics";
import type { PlatformAdapter } from "./platforms/adapter";
import { PlayStationAdapter } from "./platforms/playstation";
import { SteamAdapter } from "./platforms/steam";
import { XboxAdapter } from "./platforms/xbox";
import { buildPublicOutput, emptyState, mergeGames, topGames } from "./state";
import { KEYS, type Storage } from "./storage";
import type { Platform, PlayedGame, State } from "./types";

export interface RunConfig {
  /** Games shown on the page. */
  topN: number;
  /** Games requested from each platform per run. */
  perPlatformLimit: number;
  /** e.g. "https://games.example.com" */
  publicBaseUrl: string;
}

export interface RunDeps {
  storage: Storage;
  credentials: CredentialStore;
  config: RunConfig;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Override for tests. */
  buildAdapters?: (creds: Credentials, save: (c: Credentials) => Promise<void>) => PlatformAdapter[];
  metric?: typeof emitMetric;
}

export interface RunSummary {
  attempted: Platform[];
  succeeded: Platform[];
  failed: Partial<Record<Platform, string>>;
  published: number;
}

export const GAMES_CACHE_CONTROL = "public, max-age=3600";

export function defaultAdapters(
  creds: Credentials,
  save: (c: Credentials) => Promise<void>,
): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];
  if (creds.steam?.apiKey && creds.steam.steamId) adapters.push(new SteamAdapter(creds.steam));
  if (creds.playstation?.npsso || creds.playstation?.refreshToken) {
    adapters.push(
      new PlayStationAdapter(creds.playstation, (playstation) => save({ ...creds, playstation })),
    );
  }
  if (creds.xbox?.apiKey) adapters.push(new XboxAdapter(creds.xbox));
  return adapters;
}

export async function run(deps: RunDeps): Promise<RunSummary> {
  const f = deps.fetch ?? fetch;
  const metric = deps.metric ?? emitMetric;
  const nowDate = (deps.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const { topN, perPlatformLimit, publicBaseUrl } = deps.config;

  const creds = await deps.credentials.load();
  // Platforms save rotated tokens through this; always write the latest full object.
  let latestCreds = creds;
  const save = async (c: Credentials) => {
    latestCreds = { ...latestCreds, ...c };
    await deps.credentials.save(latestCreds);
  };
  const adapters = (deps.buildAdapters ?? defaultAdapters)(creds, save);
  if (adapters.length === 0) console.warn("No platforms configured in the credentials secret");

  let state = (await deps.storage.getJson<State>(KEYS.state)) ?? emptyState(now);

  const results = await Promise.allSettled(
    adapters.map((a) =>
      a.fetchRecentGames({
        limit: perPlatformLimit,
        fetch: f,
        metric: (name, value) => metric(name, value, { Platform: a.platform }),
      }),
    ),
  );

  const summary: RunSummary = { attempted: [], succeeded: [], failed: {}, published: 0 };
  const snapshot: Record<string, { ok: true; games: PlayedGame[] } | { ok: false; error: string }> = {};

  results.forEach((result, i) => {
    const platform = adapters[i]!.platform;
    summary.attempted.push(platform);
    const prev = state.platforms[platform] ?? {};
    if (result.status === "fulfilled") {
      summary.succeeded.push(platform);
      snapshot[platform] = { ok: true, games: result.value };
      state = mergeGames(state, result.value, now);
      state.platforms = { ...state.platforms, [platform]: { lastSuccess: now, lastAttempt: now } };
      metric("PlatformFailure", 0, { Platform: platform }, "Count");
      console.log(`${platform}: fetched ${result.value.length} games`);
    } else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      summary.failed[platform] = error;
      snapshot[platform] = { ok: false, error };
      state.platforms = { ...state.platforms, [platform]: { ...prev, lastAttempt: now, lastError: error } };
      metric("PlatformFailure", 1, { Platform: platform }, "Count");
      console.error(`${platform}: failed: ${error}`);
    }
  });

  await deps.storage.put(
    KEYS.snapshot(now.slice(0, 10)),
    JSON.stringify({ runAt: now, results: snapshot }, null, 2),
    "application/json",
  );

  const top = await ensureCovers(topGames(state, topN), deps.storage, f);
  for (const g of top) state.games[g.id] = g;
  state.updatedAt = now;

  const output = buildPublicOutput(state, top, now, publicBaseUrl);
  summary.published = output.games.length;

  await deps.storage.put(KEYS.state, JSON.stringify(state, null, 2), "application/json");
  await deps.storage.put(KEYS.games, JSON.stringify(output), "application/json", GAMES_CACHE_CONTROL);

  if (summary.attempted.length > 0 && summary.succeeded.length === 0) {
    // Output was still written from existing state; fail the invocation so the error alarm fires.
    throw new Error(`All platforms failed: ${JSON.stringify(summary.failed)}`);
  }
  return summary;
}
