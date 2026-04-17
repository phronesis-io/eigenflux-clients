type ConversationTargetKind = 'user' | 'chat' | 'channel' | 'room';
type SessionPeerShape = 'direct' | 'dm' | 'group' | 'channel' | 'room';

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNormalizedConversationTarget(value: string): boolean {
  return /^(user|chat|channel|room):/u.test(value);
}

function isSessionPeerShape(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === 'direct' ||
    normalized === 'dm' ||
    normalized === 'group' ||
    normalized === 'channel' ||
    normalized === 'room'
  );
}

function supportsKindPrefixedTargets(channel: string | undefined): boolean {
  return channel === 'feishu' || channel === 'discord';
}

function parseSessionRoute(sessionKey: string | undefined): {
  channel?: string;
  peerShape?: SessionPeerShape;
} {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return {};
  }

  const channel = readNonEmptyString(parts[2])?.toLowerCase();
  const peerShapeRaw =
    parts.length >= 6 && isSessionPeerShape(parts[4])
      ? parts[4].toLowerCase()
      : parts.length >= 5 && isSessionPeerShape(parts[3])
        ? parts[3].toLowerCase()
        : undefined;
  const peerShape = peerShapeRaw as SessionPeerShape | undefined;

  return { channel, peerShape };
}

function deriveReplyTargetKindFromSessionKey(
  sessionKey: string | undefined
): ConversationTargetKind | undefined {
  const route = parseSessionRoute(sessionKey);
  if (!supportsKindPrefixedTargets(route.channel)) {
    return undefined;
  }

  switch (route.channel) {
    case 'feishu':
      switch (route.peerShape) {
        case 'direct':
        case 'dm':
          return 'user';
        case 'group':
          return 'chat';
        default:
          return undefined;
      }
    case 'discord':
      switch (route.peerShape) {
        case 'direct':
        case 'dm':
          return 'user';
        case 'channel':
          return 'channel';
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function deriveReplyTargetKindFromValue(
  value: string,
  channel: string | undefined
): ConversationTargetKind | undefined {
  if (channel === 'feishu') {
    if (/^ou_/iu.test(value)) {
      return 'user';
    }
    if (/^oc_/iu.test(value)) {
      return 'chat';
    }
  }

  return undefined;
}

export function normalizeReplyTarget(
  value: unknown,
  options?: {
    channel?: string;
    sessionKey?: string;
    fallbackKind?: ConversationTargetKind;
  }
): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  if (isNormalizedConversationTarget(trimmed)) {
    return trimmed;
  }

  const channel = readNonEmptyString(options?.channel)?.toLowerCase();
  if (channel && trimmed.startsWith(`${channel}:`)) {
    return normalizeReplyTarget(trimmed.slice(channel.length + 1), {
      ...options,
      channel,
    });
  }

  const fallbackKind =
    deriveReplyTargetKindFromValue(trimmed, channel) ??
    (supportsKindPrefixedTargets(channel) ? options?.fallbackKind : undefined) ??
    deriveReplyTargetKindFromSessionKey(options?.sessionKey);

  return fallbackKind ? `${fallbackKind}:${trimmed}` : trimmed;
}
