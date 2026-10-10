// Minimal ambient types for the YouTube IFrame Player API
// (https://developers.google.com/youtube/iframe_api_reference). We load the
// script dynamically; these describe only the surface KudiWatch uses.
declare namespace YT {
  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }
  interface PlayerOptions {
    videoId?: string;
    width?: number | string;
    height?: number | string;
    playerVars?: Record<string, number | string>;
    events?: {
      onReady?: (e: { target: Player }) => void;
      onStateChange?: (e: { data: number; target: Player }) => void;
      onPlaybackRateChange?: (e: { data: number; target: Player }) => void;
      onError?: (e: { data: number; target: Player }) => void;
    };
  }
  class Player {
    constructor(el: HTMLElement | string, opts: PlayerOptions);
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    setPlaybackRate(rate: number): void;
    getPlaybackRate(): number;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    destroy(): void;
  }
}

interface Window {
  YT?: typeof YT;
  onYouTubeIframeAPIReady?: () => void;
}
