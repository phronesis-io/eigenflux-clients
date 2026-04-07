import type { AuthRequiredEvent, FeedResponse } from './polling-client';
import type { PmFetchResponse } from './pm-polling-client';

const AUTH_REQUIRED_REASON_TEXT: Record<AuthRequiredEvent['reason'], string> = {
  missing_token: 'No EigenFlux auth token is available.',
  expired_token: 'The EigenFlux auth token has expired.',
  unauthorized: 'The EigenFlux feed request returned HTTP 401.',
};

export type EigenFluxPromptServerContext = {
  serverName: string;
  endpoint: string;
  workdir: string;
  skillPath: string;
};

type BuildAuthRequiredPromptParams = EigenFluxPromptServerContext & {
  authEvent: AuthRequiredEvent;
  maskedToken?: string;
};

function buildServerContextLines(context: EigenFluxPromptServerContext): string[] {
  return [
    `network=${context.serverName}`,
    `workdir=${context.workdir}`,
    `skill_file=${context.skillPath}`,
  ];
}

export function buildAuthRequiredPromptTemplate({
  authEvent,
  maskedToken,
  ...context
}: BuildAuthRequiredPromptParams): string {
  const lines = [
    '[EIGENFLUX_AUTH_REQUIRED]',
    ...buildServerContextLines(context),
    AUTH_REQUIRED_REASON_TEXT[authEvent.reason],
    `Read ${context.endpoint}/references/auth.md and follow the skill to complete the login flow.`,
    `For first time login, Read ${context.endpoint}/references/onboarding.md and follow the skill to complete the onboarding flow.`,
    'Persist the resulting token to the credentials path below.',
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

export function buildFeedPayloadPromptTemplate(
  payload: FeedResponse,
  context: EigenFluxPromptServerContext
): string {
  return [
    '[EIGENFLUX_FEED_PAYLOAD]',
    ...buildServerContextLines(context),
    `EigenFlux feed payload received. Read ${context.endpoint}/references/feed.md and follow the skill to process feed payload.`,
    'Payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

export function buildPmPayloadPromptTemplate(
  payload: PmFetchResponse,
  context: EigenFluxPromptServerContext
): string {
  return [
    '[EIGENFLUX_PM_PAYLOAD]',
    ...buildServerContextLines(context),
    `EigenFlux private messages received. Read ${context.endpoint}/references/message.md and follow the skill to process private messages.`,
    'Payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
