-- Preset color keys let admins visually distinguish products in order-form
-- dropdowns without storing arbitrary user-selected color values.

ALTER TABLE friends_family_products
  ADD COLUMN color_key TEXT NOT NULL DEFAULT 'slate';

ALTER TABLE friends_family_products
  ADD CONSTRAINT friends_family_products_color_key_check
  CHECK (color_key IN ('slate', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'));
