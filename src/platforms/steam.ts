import type { SteamCredentials } from "../credentials";
import type { PlayedGame } from "../types";
import { byLastPlayedDesc, getJson, type FetchContext, type PlatformAdapter } from "./adapter";

interface OwnedGamesResponse {
  response: {
    game_count?: number;
    games?: Array<{
      appid: number;
      name?: string;
      playtime_forever: number;
      /** Unix seconds; 0 if never played. */
      rtime_last_played?: number;
    }>;
  };
}

/**
 * Uses GetOwnedGames rather than GetRecentlyPlayedGames: it includes a real
 * last-played timestamp for every game, not just a two-week window.
 */
export class SteamAdapter implements PlatformAdapter {
  readonly platform = "steam" as const;

  constructor(private readonly creds: SteamCredentials) {}

  async fetchRecentGames(ctx: FetchContext): Promise<PlayedGame[]> {
    const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
    url.searchParams.set("key", this.creds.apiKey);
    url.searchParams.set("steamid", this.creds.steamId);
    url.searchParams.set("include_appinfo", "true");
    url.searchParams.set("include_played_free_games", "true");
    url.searchParams.set("format", "json");

    const data = await getJson<OwnedGamesResponse>(ctx.fetch, url.toString());
    if (!data.response || data.response.games === undefined) {
      throw new Error("Steam returned no games list; is 'Game details' set to Public?");
    }

    return data.response.games
      .filter((g) => (g.rtime_last_played ?? 0) > 0)
      .map((g) => ({
        platform: this.platform,
        platformGameId: String(g.appid),
        title: g.name ?? `App ${g.appid}`,
        lastPlayed: new Date(g.rtime_last_played! * 1000).toISOString(),
        // Portrait library capsule; covers.ts falls back to the header image if this 404s.
        coverSourceUrl: `https://shared.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_600x900.jpg`,
      }))
      .sort(byLastPlayedDesc)
      .slice(0, ctx.limit);
  }
}

export const steamFallbackCover = (appid: string) =>
  `https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
