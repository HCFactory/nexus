-- Quantity deals let admins lower a product's unit price once a line reaches a
-- minimum quantity (e.g. 5 or more at $10 each). Deals are stored on the
-- product as [{"min_quantity": 5, "unit_price": 10}], and the order functions
-- price each line with the deal whose minimum is the highest one reached.

-- Safe to re-run: every statement below is idempotent.
ALTER TABLE friends_family_products
  ADD COLUMN IF NOT EXISTS quantity_deals JSONB NOT NULL DEFAULT '[]'::JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'friends_family_products_quantity_deals_check'
  ) THEN
    ALTER TABLE friends_family_products
      ADD CONSTRAINT friends_family_products_quantity_deals_check
      CHECK (jsonb_typeof(quantity_deals) = 'array');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION friends_family_deal_unit_price(
  p_unit_price NUMERIC,
  p_quantity_deals JSONB,
  p_quantity INTEGER
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT (deal->>'unit_price')::NUMERIC
      FROM jsonb_array_elements(COALESCE(p_quantity_deals, '[]'::JSONB)) AS deal
      WHERE (deal->>'min_quantity')::INTEGER <= p_quantity
      ORDER BY (deal->>'min_quantity')::INTEGER DESC
      LIMIT 1
    ),
    p_unit_price
  );
$$;

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

  SELECT SUM(friends_family_deal_unit_price(product.unit_price, product.quantity_deals, line.quantity) * line.quantity)::NUMERIC(12, 2)
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
    v_order_id,
    product.id,
    product.name,
    product.category,
    (line.value->>'quantity')::INTEGER,
    friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER),
    (friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER)
      * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID;

  RETURN v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_friends_family_order(
  p_order_id UUID,
  p_ordered_by TEXT,
  p_customer_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_notes TEXT,
  p_items JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID;
  v_total NUMERIC(12, 2);
BEGIN
  SELECT organization_id INTO v_org_id FROM users WHERE id = v_user_id;
  IF v_user_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'An organization membership is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM friends_family_orders
    WHERE id = p_order_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Order not found or access denied';
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
      ON product.id = line.product_id AND product.organization_id = v_org_id
    WHERE product.id IS NULL OR line.quantity IS NULL OR line.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Every line must reference a valid product with a positive quantity';
  END IF;

  SELECT SUM(friends_family_deal_unit_price(product.unit_price, product.quantity_deals, line.quantity) * line.quantity)::NUMERIC(12, 2)
  INTO v_total
  FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
  JOIN friends_family_products product
    ON product.id = line.product_id AND product.organization_id = v_org_id;

  UPDATE friends_family_orders
  SET ordered_by = BTRIM(p_ordered_by),
      customer_name = BTRIM(p_customer_name),
      phone = NULLIF(BTRIM(p_phone), ''),
      email = NULLIF(BTRIM(p_email), ''),
      notes = NULLIF(BTRIM(p_notes), ''),
      total_amount = v_total,
      updated_at = NOW()
  WHERE id = p_order_id AND organization_id = v_org_id;

  DELETE FROM friends_family_order_items WHERE order_id = p_order_id;

  INSERT INTO friends_family_order_items (
    order_id, product_id, product_name, category_name, quantity, unit_price, subtotal, sort_order
  )
  SELECT
    p_order_id,
    product.id,
    product.name,
    product.category,
    (line.value->>'quantity')::INTEGER,
    friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER),
    (friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER)
      * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID
   AND product.organization_id = v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION create_public_friends_family_order(
  p_organization_id UUID,
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
  v_sequence BIGINT;
  v_order_id UUID;
  v_total NUMERIC(12, 2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'Public order organization is not configured';
  END IF;
  IF NULLIF(BTRIM(p_ordered_by), '') IS NULL OR NULLIF(BTRIM(p_customer_name), '') IS NULL THEN
    RAISE EXCEPTION 'Ordered by and customer name are required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'An order requires between 1 and 50 line items';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
    LEFT JOIN friends_family_products product
      ON product.id = line.product_id
     AND product.organization_id = p_organization_id
     AND product.active
    WHERE product.id IS NULL OR line.quantity IS NULL OR line.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Every line must reference an active product with a positive quantity';
  END IF;

  INSERT INTO friends_family_order_counters (organization_id, current_sequence)
  VALUES (p_organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE
    SET current_sequence = friends_family_order_counters.current_sequence + 1,
        updated_at = NOW()
  RETURNING current_sequence INTO v_sequence;

  SELECT SUM(friends_family_deal_unit_price(product.unit_price, product.quantity_deals, line.quantity) * line.quantity)::NUMERIC(12, 2)
  INTO v_total
  FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
  JOIN friends_family_products product
    ON product.id = line.product_id
   AND product.organization_id = p_organization_id;

  INSERT INTO friends_family_orders (
    organization_id, order_number, order_sequence, ordered_by, customer_name,
    phone, email, notes, total_amount, created_by
  ) VALUES (
    p_organization_id, 'FF-' || LPAD(v_sequence::TEXT, 6, '0'), v_sequence,
    BTRIM(p_ordered_by), BTRIM(p_customer_name), NULLIF(BTRIM(p_phone), ''),
    NULLIF(BTRIM(p_email), ''), NULLIF(BTRIM(p_notes), ''), v_total, NULL
  ) RETURNING id INTO v_order_id;

  INSERT INTO friends_family_order_items (
    order_id, product_id, product_name, category_name, quantity, unit_price, subtotal, sort_order
  )
  SELECT
    v_order_id,
    product.id,
    product.name,
    product.category,
    (line.value->>'quantity')::INTEGER,
    friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER),
    (friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER)
      * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID
   AND product.organization_id = p_organization_id;

  RETURN v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_public_friends_family_order(
  p_organization_id UUID,
  p_order_id UUID,
  p_ordered_by TEXT,
  p_customer_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_notes TEXT,
  p_items JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC(12, 2);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM friends_family_orders
    WHERE id = p_order_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NULLIF(BTRIM(p_ordered_by), '') IS NULL OR NULLIF(BTRIM(p_customer_name), '') IS NULL THEN
    RAISE EXCEPTION 'Ordered by and customer name are required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'An order requires between 1 and 50 line items';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
    LEFT JOIN friends_family_products product
      ON product.id = line.product_id
     AND product.organization_id = p_organization_id
    WHERE product.id IS NULL OR line.quantity IS NULL OR line.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Every line must reference a valid product with a positive quantity';
  END IF;

  SELECT SUM(friends_family_deal_unit_price(product.unit_price, product.quantity_deals, line.quantity) * line.quantity)::NUMERIC(12, 2)
  INTO v_total
  FROM jsonb_to_recordset(p_items) AS line(product_id UUID, quantity INTEGER)
  JOIN friends_family_products product
    ON product.id = line.product_id
   AND product.organization_id = p_organization_id;

  UPDATE friends_family_orders
  SET ordered_by = BTRIM(p_ordered_by),
      customer_name = BTRIM(p_customer_name),
      phone = NULLIF(BTRIM(p_phone), ''),
      email = NULLIF(BTRIM(p_email), ''),
      notes = NULLIF(BTRIM(p_notes), ''),
      total_amount = v_total,
      updated_at = NOW()
  WHERE id = p_order_id AND organization_id = p_organization_id;

  DELETE FROM friends_family_order_items WHERE order_id = p_order_id;

  INSERT INTO friends_family_order_items (
    order_id, product_id, product_name, category_name, quantity, unit_price, subtotal, sort_order
  )
  SELECT
    p_order_id,
    product.id,
    product.name,
    product.category,
    (line.value->>'quantity')::INTEGER,
    friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER),
    (friends_family_deal_unit_price(product.unit_price, product.quantity_deals, (line.value->>'quantity')::INTEGER)
      * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID
   AND product.organization_id = p_organization_id;
END;
$$;
