-- Internal Friends & Family sales orders and admin-managed product catalog.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'friends_family_fulfillment_status') THEN
    CREATE TYPE friends_family_fulfillment_status AS ENUM ('new', 'processing', 'fulfilled', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'friends_family_payment_status') THEN
    CREATE TYPE friends_family_payment_status AS ENUM ('unpaid', 'paid', 'refunded');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS friends_family_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, category, name)
);

CREATE TABLE IF NOT EXISTS friends_family_order_counters (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  current_sequence BIGINT NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friends_family_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  order_sequence BIGINT NOT NULL,
  ordered_by TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  fulfillment_status friends_family_fulfillment_status NOT NULL DEFAULT 'new',
  payment_status friends_family_payment_status NOT NULL DEFAULT 'unpaid',
  notes TEXT,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, order_sequence),
  UNIQUE (organization_id, order_number)
);

CREATE TABLE IF NOT EXISTS friends_family_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES friends_family_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES friends_family_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  category_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_friends_family_products_org_category
  ON friends_family_products(organization_id, active, category, name);
CREATE INDEX IF NOT EXISTS idx_friends_family_orders_org_sequence
  ON friends_family_orders(organization_id, order_sequence DESC);
CREATE INDEX IF NOT EXISTS idx_friends_family_order_items_order
  ON friends_family_order_items(order_id, sort_order);

DROP TRIGGER IF EXISTS update_friends_family_products_updated_at ON friends_family_products;
CREATE TRIGGER update_friends_family_products_updated_at
  BEFORE UPDATE ON friends_family_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_friends_family_orders_updated_at ON friends_family_orders;
CREATE TRIGGER update_friends_family_orders_updated_at
  BEFORE UPDATE ON friends_family_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE friends_family_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends_family_order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends_family_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends_family_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Organization members can view F&F products"
  ON friends_family_products FOR SELECT TO authenticated
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Organization admins can create F&F products"
  ON friends_family_products FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = (SELECT organization_id FROM users WHERE id = auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Organization admins can update F&F products"
  ON friends_family_products FOR UPDATE TO authenticated
  USING (
    organization_id = (SELECT organization_id FROM users WHERE id = auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    organization_id = (SELECT organization_id FROM users WHERE id = auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Organization members can view F&F orders"
  ON friends_family_orders FOR SELECT TO authenticated
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Organization members can update F&F order statuses"
  ON friends_family_orders FOR UPDATE TO authenticated
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()))
  WITH CHECK (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

-- RLS limits rows; column grants limit members to the two workflow fields.
REVOKE UPDATE ON friends_family_orders FROM authenticated;
GRANT UPDATE (fulfillment_status, payment_status) ON friends_family_orders TO authenticated;

CREATE POLICY "Organization members can view F&F order items"
  ON friends_family_order_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM friends_family_orders orders
      WHERE orders.id = order_id
        AND orders.organization_id = (SELECT organization_id FROM users WHERE id = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION create_friends_family_order(
  p_ordered_by TEXT,
  p_customer_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_notes TEXT,
  p_items JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID;
  v_sequence BIGINT;
  v_order_id UUID;
  v_total NUMERIC(12, 2);
BEGIN
  SELECT organization_id INTO v_org_id FROM users WHERE id = v_user_id;
  IF v_user_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'An organization membership is required';
  END IF;
  IF NULLIF(BTRIM(p_ordered_by), '') IS NULL OR NULLIF(BTRIM(p_customer_name), '') IS NULL THEN
    RAISE EXCEPTION 'Ordered by and customer name are required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
    LEFT JOIN friends_family_products product
      ON product.id = line.product_id AND product.organization_id = v_org_id AND product.active
    WHERE product.id IS NULL OR line.quantity IS NULL OR line.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Every line must reference an active product with a positive quantity';
  END IF;

  INSERT INTO friends_family_order_counters (organization_id, current_sequence)
  VALUES (v_org_id, 1)
  ON CONFLICT (organization_id) DO UPDATE
    SET current_sequence = friends_family_order_counters.current_sequence + 1,
        updated_at = NOW()
  RETURNING current_sequence INTO v_sequence;

  SELECT SUM(product.unit_price * line.quantity)::NUMERIC(12, 2)
  INTO v_total
  FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
  JOIN friends_family_products product ON product.id = line.product_id;

  INSERT INTO friends_family_orders (
    organization_id, order_number, order_sequence, ordered_by, customer_name,
    phone, email, notes, total_amount, created_by
  ) VALUES (
    v_org_id, 'FF-' || LPAD(v_sequence::TEXT, 6, '0'), v_sequence, BTRIM(p_ordered_by),
    BTRIM(p_customer_name), NULLIF(BTRIM(p_phone), ''), NULLIF(BTRIM(p_email), ''),
    NULLIF(BTRIM(p_notes), ''), v_total, v_user_id
  ) RETURNING id INTO v_order_id;

  INSERT INTO friends_family_order_items (
    order_id, product_id, product_name, category_name, quantity, unit_price, subtotal, sort_order
  )
  SELECT
    v_order_id, product.id, product.name, product.category, line.quantity,
    product.unit_price, (product.unit_price * line.quantity)::NUMERIC(12, 2), line.ordinality - 1
  FROM jsonb_to_recordset(p_items) WITH ORDINALITY AS line(product_id UUID, quantity INTEGER, ordinality BIGINT)
  JOIN friends_family_products product ON product.id = line.product_id;

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION create_friends_family_order(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_friends_family_order(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
