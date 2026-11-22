import { describe, expect, it, vi } from "vitest";
import type { CredentialStore, Credentials } from "../src/credentials";
import type { PlatformAdapter } from "../src/platforms/adapter";
import { run, type RunDeps } from "../src/run";
import { KEYS, MemoryStorage } from "../src/storage";
import type { Platform, PlayedGame, PublicOutput, State } from "../src/types";

const NOW = new Date("2026-11-20T11:00:00.000Z");

class MemoryCreds implements CredentialStore {
  saved: Credentials[] = [];
  constructor(public creds: Credentials = {}) {}
  async load() {
    return this.creds;
  }
  async save(c: Credentials) {
    this.saved.push(c);
    this.creds = c;
  }
}

const adapter = (platform: Platform, result: PlayedGame[] | Error): PlatformAdapter => ({
  platform,
  fetchRecentGames: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

const played = (platform: Platform, id: string, lastPlayed: string): PlayedGame => ({
  platform,
  platformGameId: id,
  title: `${platform} ${id}`,
  lastPlayed,
  coverSourceUrl: `https://img.example/${platform}/${id}.jpg`,
});

const imageFetch = vi.fn(
  async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
) as unknown as typeof fetch;

function deps(storage: MemoryStorage, adapters: PlatformAdapter[], creds = new MemoryCreds()): RunDeps {
  return {
    storage,
    credentials: creds,
    config: { topN: 2, perPlatformLimit: 25, publicBaseUrl: "https://games.example.com" },
    fetch: imageFetch,
    now: () => NOW,
    buildAdapters: () => adapters,
    metric: () => {},
  };
}

describe("run", () => {
  it("publishes the top N across platforms with cached covers", async () => {
    const storage = new MemoryStorage();
    const summary = await run(
      deps(storage, [
        adapter("steam", [played("steam", "1", "2026-11-18T00:00:00Z"), played("steam", "2", "2026-01-01T00:00:00Z")]),
        adapter("xbox", [played("xbox", "9", "2026-11-19T00:00:00Z")]),
      ]),
    );

    expect(summary).toMatchObject({ succeeded: ["steam", "xbox"], published: 2 });
    const out = (await storage.getJson<PublicOutput>(KEYS.games))!;
    expect(out.games.map((g) => g.id)).toEqual(["xbox:9", "steam:1"]);
    expect(out.games[0]!.coverUrl).toBe("https://games.example.com/covers/xbox/9.jpg");
    expect(storage.objects.has("public/covers/xbox/9.jpg")).toBe(true);
    expect(storage.objects.get(KEYS.games)!.cacheControl).toBe("public, max-age=3600");

    // Everything ever seen is kept in private state, not just the top N.
    const state = (await storage.getJson<State>(KEYS.state))!;
    expect(Object.keys(state.games)).toHaveLength(3);
    expect(storage.objects.has("private/snapshots/2026-11-20.json")).toBe(true);
  });

  it("does not re-download covers it already has", async () => {
    const storage = new MemoryStorage();
    const adapters = [adapter("steam", [played("steam", "1", "2026-11-18T00:00:00Z")])];
    await run(deps(storage, adapters));
    vi.mocked(imageFetch).mockClear();
    await run(deps(storage, adapters));
    expect(imageFetch).not.toHaveBeenCalled();
  });

  it("keeps a failing platform's games and records the error privately", async () => {
    const storage = new MemoryStorage();
    await run(deps(storage, [adapter("playstation", [played("playstation", "A", "2026-11-19T00:00:00Z")])]));

    const summary = await run(
      deps(storage, [
        adapter("playstation", new Error("token expired")),
        adapter("steam", [played("steam", "1", "2026-11-01T00:00:00Z")]),
      ]),
    );

    expect(summary.failed).toEqual({ playstation: "token expired" });
    const out = (await storage.getJson<PublicOutput>(KEYS.games))!;
    expect(out.games.map((g) => g.id)).toEqual(["playstation:A", "steam:1"]);
    const state = (await storage.getJson<State>(KEYS.state))!;
    expect(state.platforms.playstation).toMatchObject({
      lastSuccess: NOW.toISOString(),
      lastError: "token expired",
    });
  });

  it("still writes output but throws when every platform fails", async () => {
    const storage = new MemoryStorage();
    await expect(run(deps(storage, [adapter("steam", new Error("down"))]))).rejects.toThrow(/All platforms failed/);
    expect(storage.objects.has(KEYS.games)).toBe(true);
  });

  it("lets adapters persist rotated credentials", async () => {
    const storage = new MemoryStorage();
    const creds = new MemoryCreds({ steam: { apiKey: "k", steamId: "1" }, playstation: { npsso: "n" } });
    await run({
      ...deps(storage, [], creds),
      buildAdapters: (_c, save) => [
        {
          platform: "playstation",
          fetchRecentGames: async () => {
            await save({ playstation: { npsso: "n", refreshToken: "r2" } });
            return [];
          },
        },
      ],
    });
    expect(creds.creds).toEqual({
      steam: { apiKey: "k", steamId: "1" },
      playstation: { npsso: "n", refreshToken: "r2" },
    });
  });
});
