import { parseYouTubeId } from '@remote-dj/shared';

// Headless embed preflight: silently load a YouTube video in a hidden, muted
// IFrame player and observe whether it PLAYS (ok) or is embed-disabled (error
// 101/150 → blocked). Runs in the CURRENT browser, so it reflects this device's
// embeddability — a controller can pre-screen a link before adding it. Uses the
// official IFrame Player API (ToS-clean); error 150 is the ground truth.

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

// biome-ignore lint/suspicious/noExplicitAny: the YouTube IFrame global is untyped
type AnyYT = any;

let apiPromise: Promise<void> | null = null;

/** Load the IFrame API once; resolves when window.YT.Player is ready. */
function loadApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const w = window as unknown as { YT?: AnyYT; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
      const sc = document.createElement('script');
      sc.src = IFRAME_API_SRC;
      document.head.appendChild(sc);
    }
  });
  return apiPromise;
}

export type EmbedVerdict = 'ok' | 'blocked' | 'unknown';

/**
 * Preflight `url` in a hidden muted player. Resolves:
 *  - 'ok'      → reached PLAYING (embeddable here).
 *  - 'blocked' → error 101/150 (embed-disabled).
 *  - 'unknown' → other error / timeout / no API → caller should fail open
 *                (proceed to add; server + play-time backstop still apply).
 */
export async function checkEmbeddable(url: string, timeoutMs = 6000): Promise<EmbedVerdict> {
  const id = parseYouTubeId(url);
  if (!id || typeof window === 'undefined') return 'unknown';
  try {
    await loadApi();
  } catch {
    return 'unknown';
  }
  const w = window as unknown as { YT?: AnyYT };
  if (!w.YT?.Player) return 'unknown';

  return new Promise<EmbedVerdict>((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:200px;height:120px;pointer-events:none;';
    document.body.appendChild(host);

    let settled = false;
    const ref: { player?: AnyYT } = {};
    const finish = (v: EmbedVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ref.player?.destroy?.();
      } catch {
        /* ignore */
      }
      host.remove();
      resolve(v);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);

    ref.player = new w.YT.Player(host, {
      width: '200',
      height: '120',
      videoId: id,
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, origin: window.location.origin },
      events: {
        onReady: (e: AnyYT) => {
          try {
            e.target.mute();
            e.target.playVideo();
          } catch {
            /* ignore */
          }
        },
        onStateChange: (e: AnyYT) => {
          if (e.data === w.YT.PlayerState.PLAYING) finish('ok');
        },
        onError: (e: AnyYT) => {
          finish(e.data === 101 || e.data === 150 ? 'blocked' : 'unknown');
        },
      },
    });
  });
}
