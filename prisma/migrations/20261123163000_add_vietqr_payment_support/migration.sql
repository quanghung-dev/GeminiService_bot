-- Additive, non-destructive migration for VietQR API Service integration,
-- atomic stock reservation, and durable transactional Telegram notification outbox.
-- Existing tables, rows, CHECK constraints, and indexes are preserved intact.

-- 1. Extend payment_provider enum with VIETQR
ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'VIETQR';

-- 2. Allow plans to declare whether customer target_email is required at checkout
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS requires_email BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Add VietQR metadata and stock-reservation tracking columns on orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_provider public.payment_provider,
  ADD COLUMN IF NOT EXISTS payment_content VARCHAR(64),
  ADD COLUMN IF NOT EXISTS payment_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_link TEXT,
  ADD COLUMN IF NOT EXISTS payment_va_account VARCHAR(64),
  ADD COLUMN IF NOT EXISTS payment_provider_ref VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stock_released_at TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS orders_pending_expires_idx
  ON public.orders (expires_at)
  WHERE status = 'PENDING'::public.order_status;

-- 4. Add callback audit fields, webhook received timestamp, and anti-double-verification unique index on payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS bank_account VARCHAR(64),
  ADD COLUMN IF NOT EXISTS trans_type VARCHAR(8),
  ADD COLUMN IF NOT EXISTS raw_payload JSONB,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS payments_order_verified_unique_idx
  ON public.payments (order_id)
  WHERE status = 'VERIFIED'::public.payment_status AND order_id IS NOT NULL;

-- 5. Create durable transactional outbox table for Telegram notifications (at-least-once delivery)
CREATE TABLE IF NOT EXISTS public.telegram_notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  dedupe_key VARCHAR(191) NOT NULL,
  chat_id BIGINT NOT NULL,
  notification_type VARCHAR(64) NOT NULL,
  order_id UUID,
  payment_id UUID,
  payload JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ(6),
  locked_by VARCHAR(128),
  lock_expires_at TIMESTAMPTZ(6),
  last_error TEXT,
  sent_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT telegram_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT telegram_notifications_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT telegram_notifications_status_check CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  CONSTRAINT telegram_notifications_attempts_check CHECK (attempts >= 0),
  CONSTRAINT telegram_notifications_max_attempts_check CHECK (max_attempts > 0),
  CONSTRAINT telegram_notifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT telegram_notifications_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS telegram_notifications_pending_idx
  ON public.telegram_notifications (next_attempt_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS telegram_notifications_processing_lock_idx
  ON public.telegram_notifications (lock_expires_at)
  WHERE status = 'PROCESSING';
