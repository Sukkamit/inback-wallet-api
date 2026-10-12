export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  QUEUED = 'QUEUED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  DELAYED = 'DELAYED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  REFUNDED = 'REFUNDED',
}

export enum ActorType {
  CUSTOMER = 'CUSTOMER',
  BOT = 'BOT',
  BANK_WEBHOOK = 'BANK_WEBHOOK',
  SYSTEM_SCHEDULER = 'SYSTEM_SCHEDULER',
  ADMIN = 'ADMIN',
}

export enum FailureType {
  TRANSIENT = 'TRANSIENT',
  PERMANENT = 'PERMANENT',
}

export interface Order {
  id: string;
  order_no: string;
  customer_id: string;
  game_id: string;
  package_id: string;
  uid: string;
  server_id?: string | null;
  amount: number;
  status: OrderStatus;
  assigned_bot_id?: string | null;
  lease_expires_at?: Date | null;
  retry_count: number;
  max_retries: number;
  last_heartbeat_at?: Date | null;
  failure_reason?: string | null;
  failure_type?: FailureType | null;
  payment_expires_at: Date;
  queued_at?: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface OrderTimeline {
  id: string;
  order_id: string;
  order_no: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor_type: ActorType;
  actor_id?: string | null;
  action: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: Date;
}

export interface OrderIssue {
  id: string;
  order_no: string;
  reported_by: string;
  category: string;
  details: string;
  resolution_status: 'OPEN' | 'RESOLVING' | 'RESOLVED';
  created_at: Date;
}

export interface CreateOrderDTO {
  customer_id: string;
  game_id: string;
  package_id: string;
  uid: string;
  server_id?: string;
  amount: number;
}

export interface PaginationParams {
  tab?: 'current' | 'history';
  page?: number;
  limit?: number;
}
