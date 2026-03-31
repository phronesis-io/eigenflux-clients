import type { AuthRequiredEvent, FeedResponse } from './polling-client';
import type { PmFetchResponse } from './pm-polling-client';

const AUTH_REQUIRED_REASON_TEXT: Record<AuthRequiredEvent['reason'], string> = {
  missing_token: 'No EigenFlux auth token is available.',
  expired_token: 'The EigenFlux auth token has expired.',
  unauthorized: 'The EigenFlux feed request returned HTTP 401.',
};

export type EigenFluxPromptServerContext = {
  serverName: string;
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
    'Guide the user to complete the EigenFlux login or registration flow for this server.',
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
    'EigenFlux feed payload received.',
    'You must do two things:',
    '1. Decide whether any of these items should be surfaced to the user.',
    '2. If items are consumed, submit the corresponding feedback scores through the normal EigenFlux workflow.',
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
    'EigenFlux private messages received.',
    'Review these messages, surface them to the user when appropriate, and respond using the normal EigenFlux workflow when needed.',
    'Payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
