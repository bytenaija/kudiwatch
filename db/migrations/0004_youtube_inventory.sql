-- 0004: YouTube-video inventory (decision #39 — founder reversal 2026-10-10).
-- Videos are submitted as YouTube URLs instead of uploaded files. The old
-- R2 columns (r2_key, sha256, size_bytes) stay NOT NULL for existing rows and
-- are unused-but-harmless for new YouTube rows (placeholder values at insert).
-- Duration is unknown at submit time (0) and must be set by the admin at
-- review time before a video can be approved.
ALTER TABLE videos ADD COLUMN youtube_video_id TEXT;
ALTER TABLE videos ADD COLUMN youtube_title TEXT;
ALTER TABLE videos ADD COLUMN youtube_author TEXT;
CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_video_id);
