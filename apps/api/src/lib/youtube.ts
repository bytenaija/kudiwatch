// YouTube helpers: URL → video ID extraction and no-key metadata via oEmbed.
// No YouTube Data API key needed. Used by the advertiser submit flow.
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract an 11-char YouTube video ID from a URL, bare ID, or return null. */
export function extractYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (YT_ID_RE.test(s)) return s; // bare video ID
  let u: URL;
  try {
    u = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const pathId = (re: RegExp): string | null => {
    const m = u.pathname.match(re);
    return m && m[1] && YT_ID_RE.test(m[1]) ? m[1]! : null;
  };
  if (host === 'youtu.be') return pathId(/^\/([A-Za-z0-9_-]{11})/);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch' || u.pathname === '/watch/') {
      const v = u.searchParams.get('v');
      return v && YT_ID_RE.test(v) ? v : null;
    }
    return pathId(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  }
  if (host === 'youtube-nocookie.com') return pathId(/^\/embed\/([A-Za-z0-9_-]{11})/);
  return null;
}

export interface YouTubeMeta {
  title: string;
  author: string;
}

/**
 * Fetch title/author via YouTube's no-key oEmbed endpoint. Returns null when
 * the video is unreachable (private, deleted, wrong ID) or YouTube is down.
 * NOTE: oEmbed does NOT report duration or embedding-disabled status — those
 * are resolved at review time (admin enters duration from the preview) and at
 * playback time (player onError), respectively.
 */
export async function fetchYouTubeMeta(videoId: string): Promise<YouTubeMeta | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      {
        headers: { 'User-Agent': 'KudiWatch/1.0' },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: unknown; author_name?: unknown };
    if (typeof j.title !== 'string' || !j.title.trim()) return null;
    return {
      title: j.title.trim().slice(0, 200),
      author: typeof j.author_name === 'string' ? j.author_name.trim().slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}
