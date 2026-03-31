/**
 * Credentials loader for the EigenFlux auth token.
 */

import * as fs from 'fs';
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
      source: 'file';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    }
  | {
      status: 'missing' | 'expired';
      source?: 'file';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    };

export class CredentialsLoader {
  private readonly logger: Logger;
  private readonly workdir: string;

  constructor(logger: Logger, workdir: string) {
    this.logger = logger;
    this.workdir = workdir;
  }

  loadAccessToken(): string | null {
    const authState = this.loadAuthState();
    if (authState.status !== 'available') {
      if (authState.status === 'missing') {
        this.logger.error(`No access token found in ${authState.credentialsPath}`);
      }
      return null;
    }
    return authState.accessToken;
  }

  loadAuthState(): AuthState {
    const credentialsPath = this.resolveCredentialsPath();

    if (fs.existsSync(credentialsPath)) {
      try {
        const content = fs.readFileSync(credentialsPath, 'utf-8');
        const credentials: EigenFluxCredentials = JSON.parse(content);

        if (credentials.access_token) {
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

          this.logger.info(`Loaded access token from ${credentialsPath}`);
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
        this.logger.error(`Failed to read credentials file: ${credentialsPath}`, error);
      }
    }

    return {
      status: 'missing',
      credentialsPath,
    };
  }

  saveAccessToken(token: string, email?: string, expiresAt?: number): void {
    const credentialsPath = this.resolveCredentialsPath();

    if (!fs.existsSync(this.workdir)) {
      fs.mkdirSync(this.workdir, { recursive: true });
    }

    const credentials: EigenFluxCredentials = {
      access_token: token,
      email,
      expires_at: expiresAt,
    };

    try {
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
      this.logger.info(`Saved access token to ${credentialsPath}`);
    } catch (error) {
      this.logger.error('Failed to save credentials file', error);
    }
  }

  private resolveCredentialsPath(): string {
    return path.join(this.workdir, PLUGIN_CONFIG.CREDENTIALS_FILE);
  }
}
