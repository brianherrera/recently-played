export const PLATFORMS = ["steam", "playstation", "xbox"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A game as reported by a platform adapter. */
export interface PlayedGame {
  platform: Platform;
  /** Platform-native ID (Steam appid, PSN titleId, Xbox titleId). */
  platformGameId: string;
  title: string;
  /** ISO-8601 UTC timestamp. */
  lastPlayed: string;
  /** Where to download cover art from, if the platform provides it. */
  coverSourceUrl?: string;
}

/** A game as tracked in private state across runs. */
export interface TrackedGame {
  /** `${platform}:${platformGameId}` */
  id: string;
  platform: Platform;
  platformGameId: string;
  title: string;
  lastPlayed: string;
  firstSeen: string;
  coverSourceUrl?: string;
  /** Key of the cached cover in the bucket (under the public prefix), once copied. */
  coverKey?: string;
}

export interface PlatformStatus {
  lastSuccess?: string;
  lastAttempt?: string;
  lastError?: string;
}

/** Private state persisted between runs. */
export interface State {
  stateVersion: 1;
  updatedAt: string;
  platforms: Partial<Record<Platform, PlatformStatus>>;
  games: Record<string, TrackedGame>;
}

/** Public output consumed by the website. */
export interface PublicOutput {
  schemaVersion: 1;
  generatedAt: string;
  platforms: Partial<Record<Platform, { lastSuccess?: string }>>;
  games: Array<{
    id: string;
    platform: Platform;
    title: string;
    lastPlayed: string;
    /** Absolute URL, e.g. "https://games.example.com/covers/steam/620.jpg". */
    coverUrl?: string;
  }>;
}
