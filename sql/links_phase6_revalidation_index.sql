-- Phase 6: Additional index for tiered revalidation queries.
-- Supports the priority ordering in handleInternalLinksPending:
--   status + last_checked_at (tier selection) + click_count (within-tier ordering).
-- The existing idx_links_scan_queue (checked, last_checked_at, claimed_at) is retained.

CREATE INDEX IF NOT EXISTS idx_links_revalidation
  ON links (status, last_checked_at, click_count);
