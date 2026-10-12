-- Database Schema for Order Tracking API

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(64) UNIQUE NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    game_id VARCHAR(64) NOT NULL,
    package_id VARCHAR(64) NOT NULL,
    uid VARCHAR(128) NOT NULL,
    server_id VARCHAR(64),
    amount NUMERIC(12, 2) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
    assigned_bot_id VARCHAR(64),
    lease_expires_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    last_heartbeat_at TIMESTAMPTZ,
    failure_reason TEXT,
    failure_type VARCHAR(32),
    payment_expires_at TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_lease ON orders(status, lease_expires_at) WHERE status = 'IN_PROGRESS';
CREATE INDEX IF NOT EXISTS idx_orders_queued_at ON orders(status, queued_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_orders_payment_expires ON orders(status, payment_expires_at) WHERE status = 'PENDING_PAYMENT';

CREATE TABLE IF NOT EXISTS order_timelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_no VARCHAR(64) NOT NULL,
    from_status VARCHAR(32),
    to_status VARCHAR(32) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(64),
    action VARCHAR(64) NOT NULL,
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timelines_order_no ON order_timelines(order_no, created_at ASC);

CREATE TABLE IF NOT EXISTS order_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(64) NOT NULL,
    reported_by VARCHAR(64) NOT NULL,
    category VARCHAR(64) NOT NULL,
    details TEXT NOT NULL,
    resolution_status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_order_no ON order_issues(order_no);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(256) PRIMARY KEY,
    resource_type VARCHAR(64) NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
    event_id VARCHAR(128) PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,
    order_no VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(64) NOT NULL UNIQUE,
    bot_id VARCHAR(64) NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
