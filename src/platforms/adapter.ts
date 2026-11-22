import type { Platform, PlayedGame } from "../types";

export interface FetchContext {
  /** Max games to return, most recent first. */
  limit: number;
  fetch: typeof fetch;
  /** Emit a numeric metric (e.g. days until a token expires). */
  metric: (name: string, value: number) => void;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  fetchRecentGames(ctx: FetchContext): Promise<PlayedGame[]>;
}

export async function getJson<T>(f: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const byLastPlayedDesc = (a: PlayedGame, b: PlayedGame) =>
  Date.parse(b.lastPlayed) - Date.parse(a.lastPlayed);
