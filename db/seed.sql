-- KudiWatch static seed: config defaults + ASN reputation.
-- Demo users/campaigns are created by scripts/seed.ts (needs hashing + ledger logic).
-- Safe to re-apply: INSERT OR REPLACE / INSERT OR IGNORE.

INSERT OR REPLACE INTO config (key, value, updated_at) VALUES
  ('heartbeat_interval_s', '10', 0),
  ('completion_pct', '90', 0),
  ('min_payout_cents', '100', 0),
  ('max_views_per_hour', '10', 0),
  ('max_views_per_day', '50', 0),
  ('otp_ttl_s', '600', 0),
  ('otp_max_attempts', '5', 0),
  ('otp_lock_s', '3600', 0),
  ('otp_resend_cooldown_s', '60', 0),
  ('session_silence_timeout_s', '60', 0),
  ('claim_ttl_s', '120', 0),
  ('watch_token_grace_s', '900', 0),
  ('attention_timeout_s', '15', 0),
  ('skip_cooldown_s', '86400', 0),
  ('heartbeat_retention_days', '90', 0),
  ('payout_mock_failure_rate', '0', 0),
  ('mock_fee_mpesa_pct', '1.5', 0),
  ('mock_fee_bank_flat_cents', '30', 0),
  ('mock_fee_airtime_pct', '0', 0),
  ('mock_fee_usdt_flat_cents', '100', 0),
  ('min_video_duration_s', '15', 0),
  ('max_video_duration_s', '180', 0),
  ('max_upload_bytes', '209715200', 0);

-- Illustrative ASN reputation seed (review/block lists). Real deployments
-- should curate this from their own abuse data.
INSERT OR IGNORE INTO asn_reputation (asn, label, risk, notes) VALUES
  (9009,   'M247 (VPN/hosting)', 'block', 'common VPN exit'),
  (20473,  'Constant Company (VPN/hosting)', 'block', 'common VPN exit'),
  (212238, 'Datacamp (proxy)', 'block', 'datacenter proxy'),
  (16509,  'Amazon EC2', 'review', 'cloud — watchers rarely originate here'),
  (15169,  'Google Cloud', 'review', 'cloud — watchers rarely originate here'),
  (14061,  'DigitalOcean', 'review', 'cloud — watchers rarely originate here'),
  (29465,  'MTN Nigeria', 'allow', 'mobile carrier NG'),
  (29423,  'Airtel Nigeria', 'allow', 'mobile carrier NG'),
  (37042,  'Safaricom', 'allow', 'mobile carrier KE'),
  (24582,  'Airtel Kenya', 'allow', 'mobile carrier KE'),
  (24560,  'Airtel India', 'allow', 'mobile carrier IN');
