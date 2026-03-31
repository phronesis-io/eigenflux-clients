/**
 * Credentials loader for EigenFlux access token.
 * Priority: {CREDENTIALS_DIR}/credentials.json > EIGENFLUX_ACCESS_TOKEN env var
 *
 * Standalone implementation (no OpenClaw SDK dependency).
 * Uses sync fs operations for simplicity.
 */

import * as fs from 'fs';
import * as path from 'path';

interface StoredCredentials {
  access_token: string;
  email?: string;
  expires_at?: number;
}

export class CredentialsLoader {
  public readonly credentialsPath: string;
  private readonly envTokenKey: string;

  constructor(credentialsDir: string, envTokenKey = 'EIGENFLUX_ACCESS_TOKEN') {
    this.credentialsPath = path.join(credentialsDir, 'credentials.json');
    this.envTokenKey = envTokenKey;
  }

  /**
   * Load access token. Returns null if unavailable or expired.
   */
  loadAccessToken(): string | null {
    // Try credentials file first
    if (fs.existsSync(this.credentialsPath)) {
      try {
        const content = fs.readFileSync(this.credentialsPath, 'utf-8');
        const creds: StoredCredentials = JSON.parse(content);

        if (creds.access_token) {
          // Check expiration if provided
          if (creds.expires_at && Date.now() >= creds.expires_at) {
            console.error('[eigenflux] Access token from credentials file has expired');
            return null;
          }
          return creds.access_token;
        }
      } catch (error) {
        console.error(`[eigenflux] Failed to read credentials file: ${this.credentialsPath}`, error);
      }
    }

    // Fall back to environment variable
    const envToken = process.env[this.envTokenKey];
    if (envToken) {
      return envToken;
    }

    return null;
  }

  /**
   * Save access token to credentials file.
   */
  saveAccessToken(token: string, email?: string, expiresAt?: number): void {
    const dir = path.dirname(this.credentialsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const creds: StoredCredentials = {
      access_token: token,
      email,
      expires_at: expiresAt,
    };

    fs.writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), 'utf-8');
    console.error(`[eigenflux] Saved access token to ${this.credentialsPath}`);
  }
}
