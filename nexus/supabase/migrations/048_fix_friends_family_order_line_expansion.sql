-- PostgreSQL does not allow WITH ORDINALITY directly beside the column
-- definition list used by jsonb_to_recordset. Expand the JSON array first so
-- line order remains available without triggering SQLSTATE 42601 at runtime.

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
    ON product.id = (line.value->>'product_id')::UUID;

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION create_friends_family_order(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_friends_family_order(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
