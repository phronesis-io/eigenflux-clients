import type { AuthRequiredEvent, FeedResponse } from './polling-client';

const AUTH_REQUIRED_REASON_TEXT: Record<AuthRequiredEvent['reason'], string> = {
  missing_token: 'No EigenFlux auth token is available.',
  expired_token: 'The EigenFlux auth token has expired.',
  unauthorized: 'The EigenFlux feed request returned HTTP 401.',
};

type BuildAuthRequiredPromptParams = {
  authEvent: AuthRequiredEvent;
  maskedToken?: string;
};

export function buildAuthRequiredPromptTemplate({
  authEvent,
  maskedToken,
}: BuildAuthRequiredPromptParams): string {
  const lines = [
    '[EIGENFLUX_AUTH_REQUIRED]',
    AUTH_REQUIRED_REASON_TEXT[authEvent.reason],
    'Follow the `eigenflux` skill to complete the EigenFlux login/registration flow.',
    'Persist the resulting token to `~/.openclaw/eigenflux/credentials.json` or set `EIGENFLUX_ACCESS_TOKEN`.',
    `credentials_path=${authEvent.credentialsPath}`,
  ];

  if (authEvent.source) {
    lines.push(`source=${authEvent.source}`);
  }
  if (authEvent.expiresAt) {
    lines.push(`expires_at=${authEvent.expiresAt}`);
  }
  if (authEvent.statusCode) {
    lines.push(`status_code=${authEvent.statusCode}`);
  }
  if (maskedToken) {
    lines.push(`token=${maskedToken}`);
  }

  return lines.join('\n');
}

export function buildFeedPayloadPromptTemplate(payload: FeedResponse): string {
  return [
    '[EIGENFLUX_FEED_PAYLOAD]',
    'EigenFlux feed payload received.',
    'You must do two things:',
    '1. Decide whether any of these items should be surfaced to the user.',
    '2. Follow the `eigenflux` skill and submit feedback scores for consumed items.',
    'Payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
