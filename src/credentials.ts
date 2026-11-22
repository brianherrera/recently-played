import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export interface SteamCredentials {
  apiKey: string;
  /** 64-bit SteamID, e.g. "76561198000000000". */
  steamId: string;
}

export interface PlayStationCredentials {
  /** NPSSO cookie from https://ca.account.sony.com/api/v1/ssocookie. Used only when no valid refresh token exists. */
  npsso?: string;
  /** Managed by the Lambda. */
  refreshToken?: string;
  /** Managed by the Lambda. ISO-8601. */
  refreshTokenExpiresAt?: string;
}

export interface XboxCredentials {
  /** OpenXBL API key. */
  apiKey: string;
}

/** Shape of the JSON stored in the Secrets Manager secret. A missing platform is skipped. */
export interface Credentials {
  steam?: SteamCredentials;
  playstation?: PlayStationCredentials;
  xbox?: XboxCredentials;
}

export interface CredentialStore {
  load(): Promise<Credentials>;
  save(creds: Credentials): Promise<void>;
}

export class SecretsManagerCredentialStore implements CredentialStore {
  constructor(
    private readonly secretId: string,
    private readonly client = new SecretsManagerClient({}),
  ) {}

  async load(): Promise<Credentials> {
    const res = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }));
    if (!res.SecretString) throw new Error(`Secret ${this.secretId} has no SecretString`);
    return JSON.parse(res.SecretString) as Credentials;
  }

  async save(creds: Credentials): Promise<void> {
    await this.client.send(
      new PutSecretValueCommand({ SecretId: this.secretId, SecretString: JSON.stringify(creds, null, 2) }),
    );
  }
}
