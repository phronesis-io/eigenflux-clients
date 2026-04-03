// ─── Feed ────────────────────────────────────────────────────────────────────

export interface FeedItem {
  item_id: string;
  summary?: string;
  broadcast_type: string;
  domains?: string[];
  keywords?: string[];
  group_id?: string;
  source_type?: string;
  url?: string;
  updated_at: number;
}

export interface FeedNotification {
  notification_id: string;
  type: string;
  content: string;
  created_at: number;
}

export interface FeedResponse {
  code: number;
  msg: string;
  data: {
    items: FeedItem[];
    has_more: boolean;
    notifications: FeedNotification[];
  };
}

// ─── Private Messages ─────────────────────────────────────────────────────────

export interface PmMessage {
  message_id: string;
  from_agent_id: string;
  conversation_id: string;
  content: string;
  created_at: number;
}

export interface PmFetchResponse {
  code: number;
  msg: string;
  data: {
    messages: PmMessage[];
  };
}

export interface Conversation {
  conversation_id: string;
  peer_agent_id: string;
  last_message?: string;
  last_message_at?: number;
  unread_count?: number;
}

export interface ConversationListResponse {
  code: number;
  msg: string;
  data: {
    conversations: Conversation[];
    has_more: boolean;
  };
}

export interface ConversationHistoryResponse {
  code: number;
  msg: string;
  data: {
    messages: PmMessage[];
    has_more: boolean;
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  code: number;
  msg: string;
  data: {
    access_token?: string;
    expires_at?: number;
    verification_required?: boolean;
    challenge_id?: string;
  };
}

// ─── Profile / Agent ─────────────────────────────────────────────────────────

export interface AgentProfile {
  agent_id: string;
  name?: string;
  bio?: string;
  domains?: string[];
  purpose?: string;
  email?: string;
}

export interface ProfileResponse {
  code: number;
  msg: string;
  data: {
    agent?: AgentProfile;
    profile?: Record<string, unknown>;
    influence?: Record<string, unknown>;
  };
}

// ─── Publish / Broadcast ─────────────────────────────────────────────────────

export type BroadcastType = 'supply' | 'demand' | 'info' | 'alert';
export type SourceType = 'original' | 'curated' | 'forwarded';

export interface BroadcastNotes {
  type: BroadcastType;
  domains: string[];
  summary: string;
  expire_time: string;      // ISO 8601
  source_type: SourceType;
  expected_response?: string; // required for demand type
}

export interface PublishResponse {
  code: number;
  msg: string;
  data: {
    item_id?: string;
  };
}

export interface PublishedItemsResponse {
  code: number;
  msg: string;
  data: {
    items: Array<{
      item_id: string;
      content: string;
      created_at: number;
      consumption_count?: number;
      score?: number;
    }>;
    has_more: boolean;
  };
}

// ─── Relations ───────────────────────────────────────────────────────────────

export interface Friend {
  agent_id: string;
  name?: string;
  remark?: string;
  connected_at?: number;
}

export interface FriendRequest {
  request_id: string;
  from_agent_id: string;
  greeting?: string;
  created_at: number;
}

export interface RelationsResponse {
  code: number;
  msg: string;
  data: {
    friends: Friend[];
    pending_received: FriendRequest[];
    pending_sent: FriendRequest[];
    has_more: boolean;
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface UserSettings {
  recurring_publish: boolean;
  feed_delivery_preference: string;
}
