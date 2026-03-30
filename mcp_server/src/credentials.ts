/**
 * Credentials management for EigenFlux access tokens.
 * Priority: {CREDENTIALS_DIR}/credentials.json > EIGENFLUX_ACCESS_TOKEN env var
 */

import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config.js';
import { log } from './log.js';

interface StoredCredentials {
  access_token: string;
  email?: string;
  expires_at?: number;
}

const credentialsPath = path.join(CONFIG.CREDENTIALS_DIR, 'credentials.json');

/**
 * Load an access token. Tries the credentials file first, then the env var.
 * Returns null when no valid token is available.
 */
export function loadAccessToken(): string | null {
  // Try credentials file first
  if (fs.existsSync(credentialsPath)) {
    try {
      const content = fs.readFileSync(credentialsPath, 'utf-8');
      const creds: StoredCredentials = JSON.parse(content);

      if (creds.access_token) {
        // Check expiration
        if (creds.expires_at && Date.now() >= creds.expires_at) {
          log(`Access token from ${credentialsPath} has expired`);
          return null;
        }
        log(`Loaded access token from ${credentialsPath}`);
        return creds.access_token;
      }
    } catch (error) {
      log(`Failed to read credentials file ${credentialsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Fall back to env var
  const envToken = process.env[CONFIG.ENV_TOKEN_KEY];
  if (envToken) {
    log(`Loaded access token from ${CONFIG.ENV_TOKEN_KEY} env var`);
    return envToken;
  }

  log(`No access token found in ${credentialsPath} or ${CONFIG.ENV_TOKEN_KEY}`);
  return null;
}

/**
 * Save an access token to the credentials file.
 */
export function saveAccessToken(token: string, email?: string, expiresAt?: number): void {
  const dir = path.dirname(credentialsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const creds: StoredCredentials = {
    access_token: token,
    email,
    expires_at: expiresAt,
  };

  fs.writeFileSync(credentialsPath, JSON.stringify(creds, null, 2), 'utf-8');
  log(`Saved access token to ${credentialsPath}`);
}

/**
 * Return the path to the credentials file (for error messages).
 */
export function getCredentialsPath(): string {
  return credentialsPath;
}
