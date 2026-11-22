import { describe, expect, it } from "vitest";
import { buildPublicOutput, emptyState, mergeGames, topGames } from "../src/state";
import type { PlayedGame } from "../src/types";

const NOW = "2026-11-20T11:00:00.000Z";
const game = (id: string, lastPlayed: string, extra: Partial<PlayedGame> = {}): PlayedGame => ({
  platform: "steam",
  platformGameId: id,
  title: `Game ${id}`,
  lastPlayed,
  ...extra,
});

describe("mergeGames", () => {
  it("adds new games with firstSeen", () => {
    const s = mergeGames(emptyState(NOW), [game("1", "2026-11-01T00:00:00.000Z")], NOW);
    expect(s.games["steam:1"]).toMatchObject({ id: "steam:1", firstSeen: NOW, title: "Game 1" });
  });

  it("moves lastPlayed forward but never backward", () => {
    let s = mergeGames(emptyState(NOW), [game("1", "2026-11-10T00:00:00.000Z")], NOW);
    s = mergeGames(s, [game("1", "2026-11-01T00:00:00.000Z")], NOW);
    expect(s.games["steam:1"]!.lastPlayed).toBe("2026-11-10T00:00:00.000Z");
    s = mergeGames(s, [game("1", "2026-11-15T00:00:00.000Z")], NOW);
    expect(s.games["steam:1"]!.lastPlayed).toBe("2026-11-15T00:00:00.000Z");
  });

  it("keeps games the platform no longer reports", () => {
    let s = mergeGames(emptyState(NOW), [game("1", "2026-01-01T00:00:00.000Z")], NOW);
    s = mergeGames(s, [game("2", "2026-11-01T00:00:00.000Z")], NOW);
    expect(Object.keys(s.games).sort()).toEqual(["steam:1", "steam:2"]);
  });

  it("keeps the cached cover across merges", () => {
    let s = mergeGames(emptyState(NOW), [game("1", "2026-11-01T00:00:00.000Z")], NOW);
    s.games["steam:1"]!.coverKey = "covers/steam/1.jpg";
    s = mergeGames(s, [game("1", "2026-11-02T00:00:00.000Z")], NOW);
    expect(s.games["steam:1"]!.coverKey).toBe("covers/steam/1.jpg");
  });

  it("treats the same ID on different platforms as separate games", () => {
    const s = mergeGames(
      emptyState(NOW),
      [game("1", "2026-11-01T00:00:00.000Z"), game("1", "2026-11-01T00:00:00.000Z", { platform: "xbox" })],
      NOW,
    );
    expect(Object.keys(s.games).sort()).toEqual(["steam:1", "xbox:1"]);
  });
});

describe("topGames", () => {
  it("sorts most recent first across platforms and limits", () => {
    const s = mergeGames(
      emptyState(NOW),
      [
        game("old", "2025-01-01T00:00:00.000Z"),
        game("new", "2026-11-19T00:00:00.000Z", { platform: "playstation" }),
        game("mid", "2026-06-01T00:00:00.000Z", { platform: "xbox" }),
      ],
      NOW,
    );
    expect(topGames(s, 2).map((g) => g.id)).toEqual(["playstation:new", "xbox:mid"]);
  });
});

describe("buildPublicOutput", () => {
  it("emits absolute cover URLs and platform status", () => {
    let s = mergeGames(emptyState(NOW), [game("620", "2026-11-19T00:00:00.000Z")], NOW);
    s.games["steam:620"]!.coverKey = "covers/steam/620.jpg";
    s = { ...s, platforms: { steam: { lastSuccess: NOW, lastAttempt: NOW, lastError: "secret" } } };
    const out = buildPublicOutput(s, topGames(s, 10), NOW, "https://games.example.com/");
    expect(out).toEqual({
      schemaVersion: 1,
      generatedAt: NOW,
      platforms: { steam: { lastSuccess: NOW } }, // errors stay private
      games: [
        {
          id: "steam:620",
          platform: "steam",
          title: "Game 620",
          lastPlayed: "2026-11-19T00:00:00.000Z",
          coverUrl: "https://games.example.com/covers/steam/620.jpg",
        },
      ],
    });
  });
});
