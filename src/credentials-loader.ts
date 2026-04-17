/**
 * Credentials loader for the EigenFlux auth token.
 *
 * Reads credentials from the eigenflux CLI's data directory:
 * ~/.eigenflux/servers/{serverName}/credentials.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

interface EigenFluxCredentials {
  access_token: string;
  email?: string;
  agent_id?: string;
  expires_at?: number;
}

export type AuthState =
  | {
      status: 'available';
      accessToken: string;
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    }
  | {
      status: 'missing' | 'expired';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    };

export class CredentialsLoader {
  private readonly logger: Logger;
  private readonly credentialsPath: string;
  private readonly credentialsDir: string;

  constructor(logger: Logger, eigenfluxHome: string, serverName: string) {
    this.logger = logger;
    this.credentialsDir = path.join(eigenfluxHome, 'servers', serverName);
    this.credentialsPath = path.join(this.credentialsDir, 'credentials.json');
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
    if (fs.existsSync(this.credentialsPath)) {
      try {
        const content = fs.readFileSync(this.credentialsPath, 'utf-8');
        const credentials: EigenFluxCredentials = JSON.parse(content);

        if (credentials.access_token) {
          if (credentials.expires_at) {
            const now = Date.now();
            if (now >= credentials.expires_at) {
              this.logger.warn('Access token has expired');
              return {
                status: 'expired',
                credentialsPath: this.credentialsPath,
                expiresAt: credentials.expires_at,
                email: credentials.email,
              };
            }
          }

          this.logger.info(`Loaded access token from ${this.credentialsPath}`);
          return {
            status: 'available',
            accessToken: credentials.access_token,
            credentialsPath: this.credentialsPath,
            expiresAt: credentials.expires_at,
            email: credentials.email,
          };
        }
      } catch (error) {
        this.logger.error(`Failed to read credentials file: ${this.credentialsPath}`, error);
      }
    }

    return {
      status: 'missing',
      credentialsPath: this.credentialsPath,
    };
  }

  saveAccessToken(token: string, email?: string, expiresAt?: number): void {
    if (!fs.existsSync(this.credentialsDir)) {
      fs.mkdirSync(this.credentialsDir, { recursive: true });
    }

    const credentials: EigenFluxCredentials = {
      access_token: token,
      email,
      expires_at: expiresAt,
    };

    try {
      fs.writeFileSync(this.credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
      this.logger.info(`Saved access token to ${this.credentialsPath}`);
    } catch (error) {
      this.logger.error('Failed to save credentials file', error);
    }
  }
}
