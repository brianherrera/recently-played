import {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getUserPlayedGames,
  type AuthTokensResponse,
} from "psn-api";
import type { PlayStationCredentials } from "../credentials";
import type { PlayedGame } from "../types";
import { byLastPlayedDesc, type FetchContext, type PlatformAdapter } from "./adapter";

/** Don't trust a refresh token that expires within this window. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
/** Preferred cover image types from concept media, best first. */
const COVER_TYPES = ["PORTRAIT_BANNER", "GAMEHUB_COVER_ART", "MASTER"];

export type SaveCredentials = (creds: PlayStationCredentials) => Promise<void>;

export class PlayStationAdapter implements PlatformAdapter {
  readonly platform = "playstation" as const;

  constructor(
    private readonly creds: PlayStationCredentials,
    /** Called as soon as new tokens are obtained, before anything else can fail. */
    private readonly saveCredentials: SaveCredentials,
    private readonly now: () => number = Date.now,
  ) {}

  async fetchRecentGames(ctx: FetchContext): Promise<PlayedGame[]> {
    const tokens = await this.authenticate();
    const refreshTokenExpiresAt = new Date(this.now() + tokens.refreshTokenExpiresIn * 1000).toISOString();
    await this.saveCredentials({
      ...this.creds,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt,
    });
    ctx.metric("PlayStationRefreshTokenDaysRemaining", tokens.refreshTokenExpiresIn / 86_400);

    const res = await getUserPlayedGames({ accessToken: tokens.accessToken }, "me", {
      limit: ctx.limit,
      offset: 0,
      categories: "ps4_game,ps5_native_game",
    });
    if (!res?.titles) throw new Error(`Unexpected PSN response: ${JSON.stringify(res).slice(0, 300)}`);

    return res.titles
      .filter((t) => t.lastPlayedDateTime)
      .map((t) => ({
        platform: this.platform,
        platformGameId: t.titleId,
        title: t.localizedName || t.name,
        lastPlayed: new Date(t.lastPlayedDateTime).toISOString(),
        coverSourceUrl: pickCover(t) ?? undefined,
      }))
      .sort(byLastPlayedDesc)
      .slice(0, ctx.limit);
  }

  private async authenticate(): Promise<AuthTokensResponse> {
    const { refreshToken, refreshTokenExpiresAt, npsso } = this.creds;
    const refreshUsable =
      refreshToken && refreshTokenExpiresAt && Date.parse(refreshTokenExpiresAt) - this.now() > REFRESH_MARGIN_MS;

    if (refreshUsable) {
      try {
        const tokens = await exchangeRefreshTokenForAuthTokens(refreshToken);
        if (tokens.accessToken && tokens.refreshToken) return tokens;
        console.warn("PSN refresh returned no tokens; falling back to NPSSO");
      } catch (err) {
        console.warn("PSN refresh failed; falling back to NPSSO", err);
      }
    }

    if (!npsso) {
      throw new Error("PSN: no usable refresh token and no NPSSO. Re-login required (see README).");
    }
    const code = await exchangeNpssoForAccessCode(npsso).catch((err: unknown) => {
      throw new Error(`PSN: NPSSO exchange failed, NPSSO is probably expired. Re-login required. ${String(err)}`);
    });
    const tokens = await exchangeAccessCodeForAuthTokens(code);
    if (!tokens.accessToken || !tokens.refreshToken) throw new Error("PSN: code exchange returned no tokens");
    return tokens;
  }
}

type PsnTitle = Awaited<ReturnType<typeof getUserPlayedGames>>["titles"][number];

function pickCover(t: PsnTitle): string | null {
  const images = t.concept?.media?.images ?? [];
  for (const type of COVER_TYPES) {
    const hit = images.find((i) => i.type === type && i.url);
    if (hit) return hit.url;
  }
  return t.localizedImageUrl || t.imageUrl || null;
}
