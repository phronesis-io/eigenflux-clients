/**
 * Credentials loader for auth token
 * Priority: ~/.openclaw/eigenflux/credentials.json > environment variable
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { PLUGIN_CONFIG } from './config';

interface EigenFluxCredentials {
  access_token: string;
  email?: string;
  expires_at?: number;
}

export type AuthState =
  | {
      status: 'available';
      accessToken: string;
      source: 'file' | 'env';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    }
  | {
      status: 'missing' | 'expired';
      source?: 'file' | 'env';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    };

export class CredentialsLoader {
  private logger: Logger;
  private openClawHome: string;

  constructor(logger: Logger, openClawHome?: string) {
    this.logger = logger;
    this.openClawHome =
      (openClawHome || process.env.OPENCLAW_HOME || '').trim() ||
      path.join(os.homedir(), '.openclaw');
  }

  /**
   * Load access token from credentials file or environment variable
   * Priority: ~/.openclaw/eigenflux/credentials.json > EIGENFLUX_ACCESS_TOKEN env var
   */
  loadAccessToken(): string | null {
    const authState = this.loadAuthState();
    if (authState.status !== 'available') {
      if (authState.status === 'missing') {
        this.logger.error(
          `No access token found in ${authState.credentialsPath} or ${PLUGIN_CONFIG.ENV_TOKEN_KEY}`
        );
      }
      return null;
    }
    return authState.accessToken;
  }

  loadAuthState(): AuthState {
    const credentialsPath = path.join(
      this.openClawHome,
      PLUGIN_CONFIG.CREDENTIALS_FILE
    );

    // Try credentials file first.
    if (fs.existsSync(credentialsPath)) {
      try {
        const content = fs.readFileSync(credentialsPath, 'utf-8');
        const credentials: EigenFluxCredentials = JSON.parse(content);

        if (credentials.access_token) {
          // Check expiration if provided
          if (credentials.expires_at) {
            const now = Date.now();
            if (now >= credentials.expires_at) {
              this.logger.warn('Access token has expired');
              return {
                status: 'expired',
                source: 'file',
                credentialsPath,
                expiresAt: credentials.expires_at,
                email: credentials.email,
              };
            }
          }

          this.logger.info(
            `Loaded access token from ${credentialsPath}`
          );
          return {
            status: 'available',
            accessToken: credentials.access_token,
            source: 'file',
            credentialsPath,
            expiresAt: credentials.expires_at,
            email: credentials.email,
          };
        }
      } catch (error) {
        this.logger.error(
          `Failed to read credentials file: ${credentialsPath}`,
          error
        );
      }
    }

    // Fall back to environment variable
    const envToken = process.env[PLUGIN_CONFIG.ENV_TOKEN_KEY];
    if (envToken) {
      this.logger.info(
        `Loaded access token from ${PLUGIN_CONFIG.ENV_TOKEN_KEY} environment variable`
      );
      return {
        status: 'available',
        accessToken: envToken,
        source: 'env',
        credentialsPath,
      };
    }

    return {
      status: 'missing',
      credentialsPath,
    };
  }

  /**
   * Save access token to OpenClaw credentials file
   */
  saveAccessToken(token: string, email?: string, expiresAt?: number): void {
    const credentialsPath = path.join(
      this.openClawHome,
      PLUGIN_CONFIG.CREDENTIALS_FILE
    );

    // Ensure directory exists
    const dir = path.dirname(credentialsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const credentials: EigenFluxCredentials = {
      access_token: token,
      email,
      expires_at: expiresAt,
    };

    try {
      fs.writeFileSync(
        credentialsPath,
        JSON.stringify(credentials, null, 2),
        'utf-8'
      );
      this.logger.info(`Saved access token to ${credentialsPath}`);
    } catch (error) {
      this.logger.error('Failed to save credentials file', error);
    }
  }
}
