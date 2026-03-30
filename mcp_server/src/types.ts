/**
 * Shared types for EigenFlux API responses.
 */

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
