-- Replace the initial generic workflow values with the specific fulfillment
-- and payment states used by the Friends & Family order desk.

ALTER TABLE friends_family_orders
  ALTER COLUMN fulfillment_status DROP DEFAULT,
  ALTER COLUMN payment_status DROP DEFAULT;

ALTER TABLE friends_family_orders
  ALTER COLUMN fulfillment_status TYPE TEXT
    USING CASE fulfillment_status::TEXT
      WHEN 'processing' THEN 'packed'
      WHEN 'cancelled' THEN 'new'
      ELSE fulfillment_status::TEXT
    END,
  ALTER COLUMN payment_status TYPE TEXT
    USING CASE payment_status::TEXT
      WHEN 'paid' THEN 'cash_paid'
      WHEN 'refunded' THEN 'unpaid'
      ELSE payment_status::TEXT
    END;

ALTER TABLE friends_family_orders
  ADD CONSTRAINT friends_family_orders_fulfillment_status_check
    CHECK (fulfillment_status IN ('new', 'packed', 'fulfilled')),
  ADD CONSTRAINT friends_family_orders_payment_status_check
    CHECK (payment_status IN ('unpaid', 'cash_paid', 'square_paid', 'venmo_paid'));

ALTER TABLE friends_family_orders
  ALTER COLUMN fulfillment_status SET DEFAULT 'new',
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';
