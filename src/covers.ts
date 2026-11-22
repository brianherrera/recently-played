import { steamFallbackCover } from "./platforms/steam";
import { KEYS, type Storage } from "./storage";
import type { TrackedGame } from "./types";

const MAX_BYTES = 5 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
/** Covers are keyed by game ID and never change, so cache them for a long time. */
export const COVER_CACHE_CONTROL = "public, max-age=2592000";

/**
 * Copy cover art into our bucket for any game that doesn't have it yet.
 * Failures are logged and retried on the next run; a missing cover never fails the run.
 * Returns the games with coverKey filled in where a copy succeeded.
 */
export async function ensureCovers(
  games: TrackedGame[],
  storage: Storage,
  f: typeof fetch,
): Promise<TrackedGame[]> {
  return Promise.all(
    games.map(async (game) => {
      if (game.coverKey || !game.coverSourceUrl) return game;
      const candidates = [game.coverSourceUrl];
      if (game.platform === "steam") candidates.push(steamFallbackCover(game.platformGameId));

      for (const url of candidates) {
        try {
          const img = await download(url, f);
          if (!img) continue;
          const coverKey = `covers/${game.platform}/${safe(game.platformGameId)}.${img.ext}`;
          await storage.put(KEYS.cover(coverKey), img.bytes, img.contentType, COVER_CACHE_CONTROL);
          return { ...game, coverKey };
        } catch (err) {
          console.warn(`Cover download failed for ${game.id} from ${url}`, err);
        }
      }
      return game;
    }),
  );
}

async function download(url: string, f: typeof fetch) {
  const res = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
  return { bytes, contentType, ext };
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
