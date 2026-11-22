import type { XboxCredentials } from "../credentials";
import type { PlayedGame } from "../types";
import { byLastPlayedDesc, getJson, type FetchContext, type PlatformAdapter } from "./adapter";

/**
 * OpenXBL proxies Xbox's "titlehub" title-history endpoint. Field names below follow
 * titlehub's response; parsing is defensive because OpenXBL doesn't publish a schema.
 */
interface TitleHistory {
  titles?: Array<{
    titleId?: string;
    name?: string;
    /** "Game" | "App" */
    type?: string;
    displayImage?: string;
    images?: Array<{ url?: string; type?: string }>;
    titleHistory?: { lastTimePlayed?: string };
  }>;
}

/** OpenXBL wraps the titlehub payload as `{ code, content: { xuid, titles, ... } }`. */
type TitleHistoryResponse = TitleHistory & { content?: TitleHistory };

export const OPENXBL_BASE_URL = "https://api.xbl.io/v2";
const COVER_TYPES = ["Poster", "BoxArt"];

export class XboxAdapter implements PlatformAdapter {
  readonly platform = "xbox" as const;

  constructor(
    private readonly creds: XboxCredentials,
    private readonly baseUrl = OPENXBL_BASE_URL,
  ) {}

  async fetchRecentGames(ctx: FetchContext): Promise<PlayedGame[]> {
    const data = await getJson<TitleHistoryResponse>(ctx.fetch, `${this.baseUrl}/player/titleHistory`, {
      headers: {
        "X-Authorization": this.creds.apiKey,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    });
    const titles = data.content?.titles ?? data.titles;
    if (!Array.isArray(titles)) {
      throw new Error(`Unexpected OpenXBL response: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const games: PlayedGame[] = [];
    for (const t of titles) {
      const lastPlayed = t.titleHistory?.lastTimePlayed;
      if (!t.titleId || !t.name || !lastPlayed) continue;
      if (t.type && t.type !== "Game") continue; // skip apps (Netflix, YouTube, ...)
      const cover =
        COVER_TYPES.map((type) => t.images?.find((i) => i.type === type && i.url)?.url).find(Boolean) ??
        t.displayImage;
      games.push({
        platform: this.platform,
        platformGameId: t.titleId,
        title: t.name,
        lastPlayed: new Date(lastPlayed).toISOString(),
        coverSourceUrl: cover ? normalizeUrl(cover) : undefined,
      });
    }
    return games.sort(byLastPlayedDesc).slice(0, ctx.limit);
  }
}

/** Xbox image URLs are sometimes protocol-relative or plain http. */
function normalizeUrl(url: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  return url.replace(/^http:\/\//, "https://");
}
