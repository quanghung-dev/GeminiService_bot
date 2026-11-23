BEGIN;

-- 1. Create plan_handle_type enum idempotently
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'plan_handle_type'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.plan_handle_type AS ENUM (
      'LINK',
      'CUSTOMER_ACCOUNT',
      'PROVIDED_ACCOUNT',
      'OTHER'
    );
  END IF;
END $$;

-- 2. Add handle_type and handle_config on plans, backfill from requires_email, then drop requires_email
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS handle_type public.plan_handle_type NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS handle_config JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'plans'
      AND column_name = 'requires_email'
  ) THEN
    UPDATE public.plans
    SET
      handle_type = 'CUSTOMER_ACCOUNT'::public.plan_handle_type,
      handle_config = '{"fields":[{"key":"usernameOrEmail","required":true,"validate":"email"}]}'::jsonb
    WHERE requires_email = TRUE;

    ALTER TABLE public.plans DROP COLUMN requires_email;
  END IF;
END $$;

-- 3. Snapshot handle_type on orders and backfill existing orders from plans
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS handle_type public.plan_handle_type NOT NULL DEFAULT 'OTHER';

UPDATE public.orders o
SET handle_type = p.handle_type
FROM public.plans p
WHERE o.plan_id = p.id
  AND o.handle_type <> p.handle_type;

-- 4. Create 1-1 order_fulfillments table for customer_input and delivery_data
CREATE TABLE IF NOT EXISTS public.order_fulfillments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  handle_type public.plan_handle_type NOT NULL,
  customer_input JSONB,
  delivery_data JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT order_fulfillments_pkey PRIMARY KEY (id),
  CONSTRAINT order_fulfillments_order_id_key UNIQUE (order_id),
  CONSTRAINT order_fulfillments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- 5. Make subscriptions.target_email nullable and add account_identifier
ALTER TABLE public.subscriptions
  ALTER COLUMN target_email DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS account_identifier VARCHAR(255);

UPDATE public.subscriptions
SET account_identifier = target_email
WHERE account_identifier IS NULL
  AND target_email IS NOT NULL;

COMMIT;
