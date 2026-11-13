-- Migration 061: force a one-time refill of customer card fields.
--
-- Migration 060 added columns that are filled from the BC customer card:
-- contact_no, mobile_phone_no, ship_to_code and shipment_method_code.
-- Customer sync skips cards whose etag is unchanged, so existing rows would
-- never receive them. Clearing bc_card_etag makes the next customer Sync
-- refill every card.
--
-- Safe to re-run: it only forces one more full refill.
update public.business_central_customers set bc_card_etag = null;
