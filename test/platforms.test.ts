import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("psn-api", () => ({
  exchangeRefreshTokenForAuthTokens: vi.fn(),
  exchangeNpssoForAccessCode: vi.fn(),
  exchangeAccessCodeForAuthTokens: vi.fn(),
  getUserPlayedGames: vi.fn(),
}));

import * as psn from "psn-api";
import type { FetchContext } from "../src/platforms/adapter";
import { PlayStationAdapter } from "../src/platforms/playstation";
import { SteamAdapter } from "../src/platforms/steam";
import { XboxAdapter } from "../src/platforms/xbox";

const jsonFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const ctx = (f: typeof fetch = jsonFetch({})): FetchContext & { metrics: Record<string, number> } => {
  const metrics: Record<string, number> = {};
  return { limit: 2, fetch: f, metric: (n, v) => (metrics[n] = v), metrics };
};

describe("SteamAdapter", () => {
  it("returns played games newest first, skipping never-played", async () => {
    const f = jsonFetch({
      response: {
        games: [
          { appid: 10, name: "Old", playtime_forever: 5, rtime_last_played: 1_600_000_000 },
          { appid: 20, name: "Never", playtime_forever: 0, rtime_last_played: 0 },
          { appid: 30, name: "New", playtime_forever: 9, rtime_last_played: 1_790_000_000 },
          { appid: 40, name: "Mid", playtime_forever: 9, rtime_last_played: 1_700_000_000 },
        ],
      },
    });
    const games = await new SteamAdapter({ apiKey: "k", steamId: "s" }).fetchRecentGames(ctx(f));
    expect(games.map((g) => g.title)).toEqual(["New", "Mid"]);
    expect(games[0]).toMatchObject({ platform: "steam", platformGameId: "30", lastPlayed: "2026-09-21T14:13:20.000Z" });
    expect(String(vi.mocked(f).mock.calls[0]![0])).toContain("steamid=s");
  });

  it("explains a private profile", async () => {
    await expect(
      new SteamAdapter({ apiKey: "k", steamId: "s" }).fetchRecentGames(ctx(jsonFetch({ response: {} }))),
    ).rejects.toThrow(/Game details/);
  });

  it("surfaces HTTP errors", async () => {
    await expect(
      new SteamAdapter({ apiKey: "k", steamId: "s" }).fetchRecentGames(ctx(jsonFetch({}, 403))),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("XboxAdapter", () => {
  it("parses title history, skips apps and prefers box art", async () => {
    const f = jsonFetch({
      code: 200,
      content: { xuid: "x", titles: [
        { titleId: "1", name: "Halo", type: "Game", displayImage: "http://img/halo-icon.png",
          images: [{ type: "BoxArt", url: "http://img/halo-box.png" }],
          titleHistory: { lastTimePlayed: "2026-11-18T10:00:00.000Z" } },
        { titleId: "2", name: "Netflix", type: "App", titleHistory: { lastTimePlayed: "2026-11-19T10:00:00.000Z" } },
        { titleId: "3", name: "Forza", type: "Game", displayImage: "//img/forza.png",
          titleHistory: { lastTimePlayed: "2026-11-19T09:00:00.000Z" } },
      ] },
    });
    const games = await new XboxAdapter({ apiKey: "key" }).fetchRecentGames(ctx(f));
    expect(games.map((g) => [g.title, g.coverSourceUrl])).toEqual([
      ["Forza", "https://img/forza.png"],
      ["Halo", "https://img/halo-box.png"],
    ]);
    const [url, init] = vi.mocked(f).mock.calls[0]!;
    expect(url).toBe("https://api.xbl.io/v2/player/titleHistory");
    expect((init!.headers as Record<string, string>)["X-Authorization"]).toBe("key");
  });

  it("also accepts an unwrapped titlehub response", async () => {
    const f = jsonFetch({
      titles: [{ titleId: "1", name: "Halo", type: "Game", titleHistory: { lastTimePlayed: "2026-11-18T10:00:00.000Z" } }],
    });
    const games = await new XboxAdapter({ apiKey: "key" }).fetchRecentGames(ctx(f));
    expect(games.map((g) => g.title)).toEqual(["Halo"]);
  });
});

describe("PlayStationAdapter", () => {
  const tokens = { accessToken: "a", refreshToken: "r2", refreshTokenExpiresIn: 60 * 86_400, expiresIn: 3600 };
  const now = () => Date.parse("2026-11-20T00:00:00.000Z");

  beforeEach(() => {
    vi.mocked(psn.getUserPlayedGames).mockResolvedValue({
      titles: [
        { titleId: "PPSA1", name: "Astro", localizedName: "Astro Bot", imageUrl: "https://img/icon.png",
          lastPlayedDateTime: "2026-11-19T20:00:00Z",
          concept: { media: { images: [{ type: "PORTRAIT_BANNER", url: "https://img/portrait.png" }] } } },
      ],
    } as never);
  });

  it("uses a valid refresh token and saves the rotated one before fetching", async () => {
    vi.mocked(psn.exchangeRefreshTokenForAuthTokens).mockResolvedValue(tokens as never);
    const order: string[] = [];
    const save = vi.fn(async () => void order.push("save"));
    vi.mocked(psn.getUserPlayedGames).mockImplementationOnce(async () => {
      order.push("fetch");
      return { titles: [] } as never;
    });
    const c = ctx();
    await new PlayStationAdapter(
      { npsso: "n", refreshToken: "r1", refreshTokenExpiresAt: "2026-12-20T00:00:00.000Z" },
      save,
      now,
    ).fetchRecentGames(c);

    expect(psn.exchangeRefreshTokenForAuthTokens).toHaveBeenCalledWith("r1");
    expect(psn.exchangeNpssoForAccessCode).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      npsso: "n",
      refreshToken: "r2",
      refreshTokenExpiresAt: "2027-01-19T00:00:00.000Z",
    });
    expect(order).toEqual(["save", "fetch"]);
    expect(c.metrics.PlayStationRefreshTokenDaysRemaining).toBe(60);
  });

  it("falls back to NPSSO when the refresh token is expired", async () => {
    vi.mocked(psn.exchangeNpssoForAccessCode).mockResolvedValue("code");
    vi.mocked(psn.exchangeAccessCodeForAuthTokens).mockResolvedValue(tokens as never);
    vi.mocked(psn.exchangeRefreshTokenForAuthTokens).mockClear();
    const games = await new PlayStationAdapter(
      { npsso: "n", refreshToken: "old", refreshTokenExpiresAt: "2026-11-01T00:00:00.000Z" },
      async () => {},
      now,
    ).fetchRecentGames(ctx());

    expect(psn.exchangeRefreshTokenForAuthTokens).not.toHaveBeenCalled();
    expect(psn.exchangeNpssoForAccessCode).toHaveBeenCalledWith("n");
    expect(games).toEqual([
      { platform: "playstation", platformGameId: "PPSA1", title: "Astro Bot",
        lastPlayed: "2026-11-19T20:00:00.000Z", coverSourceUrl: "https://img/portrait.png" },
    ]);
  });

  it("asks for a re-login when nothing usable is left", async () => {
    await expect(new PlayStationAdapter({}, async () => {}, now).fetchRecentGames(ctx())).rejects.toThrow(
      /Re-login required/,
    );
  });
});
