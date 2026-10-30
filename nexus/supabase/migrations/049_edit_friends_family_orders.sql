-- Allow organization members to replace an order's editable details and line
-- items atomically, or delete an order, without exposing unrestricted table
-- writes through PostgREST.

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

  SELECT SUM(product.unit_price * line.quantity)::NUMERIC(12, 2)
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
    product.unit_price,
    (product.unit_price * (line.value->>'quantity')::INTEGER)::NUMERIC(12, 2),
    line.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS line(value, ordinality)
  JOIN friends_family_products product
    ON product.id = (line.value->>'product_id')::UUID
   AND product.organization_id = v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_friends_family_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM users WHERE id = v_user_id;
  IF v_user_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'An organization membership is required';
  END IF;

  DELETE FROM friends_family_orders
  WHERE id = p_order_id AND organization_id = v_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or access denied';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION update_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_friends_family_order(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION delete_friends_family_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_friends_family_order(UUID) TO authenticated;
