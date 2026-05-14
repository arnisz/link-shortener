-- Phase 6: Burst-Revalidation — persisted watermark for the one-shot trigger.
-- last_scanned_click_count stores the click_count at the time of the last scan.
-- The pending query uses:
--   click_count >= BURST_THRESHOLD AND last_scanned_click_count < BURST_THRESHOLD
-- to detect that the 40-click threshold was crossed since the last scan.
-- handleInternalScanResult writes the current click_count into this field after
-- each successful scan so the burst trigger fires at most once per scan cycle.
ALTER TABLE links
  ADD COLUMN last_scanned_click_count INTEGER NOT NULL DEFAULT 0;

-- Index to support the new burst-revalidation priority class efficiently.
-- Covers: checked=1, manual_override=0, created_at (freshness window),
--         click_count and last_scanned_click_count (threshold check), claimed_at.
CREATE INDEX IF NOT EXISTS idx_links_burst_revalidation
  ON links (checked, manual_override, created_at, click_count, last_scanned_click_count, claimed_at);
