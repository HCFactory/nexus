-- Permit the server-only service role to create Friends & Family orders for
-- the configured public organization without granting anonymous table access.

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

  SELECT SUM(product.unit_price * line.quantity)::NUMERIC(12, 2)
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
    product.unit_price,
    (product.unit_price * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
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

  SELECT SUM(product.unit_price * line.quantity)::NUMERIC(12, 2)
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
    product.unit_price,
    (product.unit_price * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID
   AND product.organization_id = p_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_public_friends_family_order(
  p_organization_id UUID,
  p_order_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM friends_family_orders
  WHERE id = p_order_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION create_public_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_public_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION create_public_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_public_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION update_public_friends_family_order(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_public_friends_family_order(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION update_public_friends_family_order(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_public_friends_family_order(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION delete_public_friends_family_order(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_public_friends_family_order(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION delete_public_friends_family_order(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION delete_public_friends_family_order(UUID, UUID) TO service_role;
