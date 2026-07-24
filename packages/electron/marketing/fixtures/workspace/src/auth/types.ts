export interface UserPayload {
  id: string;
  email: string;
  role: 'admin' | 'user' | 'viewer';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  key: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revoked: boolean;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  refreshTokenExpiresIn: string;
  apiKeyPrefix: string;
  maxApiKeysPerUser: number;
}
