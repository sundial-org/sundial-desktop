export type SupportAttachment = {
  path: string;
  name: string;
  mime: string | null;
  size: number | null;
  signedUrl?: string | null;
};

export type SupportMessage = {
  id: string;
  threadId: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  attachments: SupportAttachment[];
  createdAt: string;
  responseStatus?: 'pending' | 'processing' | 'answered' | 'failed' | null;
};

export type SupportThreadPayload = {
  threadId: string;
  messages: SupportMessage[];
  unreadCount: number;
  lastSequence: number;
  contactEmail?: string | null;
};
