-- Revert temporary PO item catalog layer from migration 034.
-- The app now uses existing packaging items (`items`) as the source for
-- purchase-order item name/category combinations, so `po_items` and
-- `order_items.po_item_id` are no longer used.

DROP INDEX IF EXISTS idx_order_items_po_item_id;
DROP INDEX IF EXISTS idx_po_items_bc_item;
DROP INDEX IF EXISTS idx_po_items_org_bc_name_category;

ALTER TABLE order_items
  DROP COLUMN IF EXISTS po_item_id;

-- CASCADE also removes the table-owned trigger and policies when the temporary
-- table exists, while remaining safe on databases where migration 034 was
-- never applied.
DROP TABLE IF EXISTS po_items CASCADE;
