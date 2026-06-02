'use client';

import { ControlPanel } from '@/components/ControlPanel';
import { playbackErrorMessage } from '@/lib/errors';
import {
  actions,
  connectRoom,
  useConnected,
  useCurrentTrack,
  useIsPlaying,
  useLastError,
  useLastSeek,
  useProgress,
  useTrackGain,
  useVolume,
} from '@/lib/roomStore';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

// NOTE: YouTube login is handled in the phone's own browser session — the
// Player must be signed into YouTube in this browser for playback to work.

// Minimal typings for the YouTube IFrame Player API (loaded at runtime).
interface YTPlayer {
  // Accepts either a bare id or the object form, which supports a start offset
  // (startSeconds) used to RESUME a track from its last known position.
  loadVideoById(id: string | { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  setVolume(volume: number): void;
  // Mobile autoplay forces a muted start; we must explicitly unMute() once a
  // non-zero volume is wanted, or setVolume() alone produces no audible change.
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}
interface YTStateChangeEvent {
  data: number;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      height?: string;
      width?: string;
      playerVars?: Record<string, unknown>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: YTStateChangeEvent) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

function PlayerInner() {
  const params = useSearchParams();
  const room = params.get('room') ?? '';

  useEffect(() => {
    const password =
      typeof window !== 'undefined'
        ? (sessionStorage.getItem(`rdj:pw:${room}`) ?? undefined)
        : undefined;
    return connectRoom(room, 'player', undefined, password);
  }, [room]);

  const connected = useConnected();
  const lastError = useLastError();
  const currentTrack = useCurrentTrack();
  const stateIsPlaying = useIsPlaying();
  const stateVolume = useVolume();
  const trackGain = useTrackGain();
  const lastSeek = useLastSeek();
  const progress = useProgress();

  // Latest local YouTube playback error code (null = no current error).
  const [errorCode, setErrorCode] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  // Mirror of readyRef as STATE so the track-load effect re-runs once the player
  // becomes ready (fixes the race where room state arrives before onReady).
  const [ready, setReady] = useState(false);
  // Latest current track id, mirrored to a ref so the onError callback (created
  // once) can tag the failed videoId for the server's stale-error guard.
  const trackIdRef = useRef<string | null>(null);
  // Guard so a single playback end reports trackEnded at most once.
  const endedRef = useRef(false);
  // Last applied seek timestamp — so we only seek when the server pushes a new one.
  const lastSeekTsRef = useRef<number | null>(null);
  // Latest progress, mirrored into a ref so the trackId load effect can read it
  // to RESUME without re-running on every progress tick.
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Inject the IFrame API script once and build the player.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function createPlayer() {
      if (!window.YT || !containerRef.current || playerRef.current) return;
      playerRef.current = new window.YT.Player(containerRef.current, {
        height: '100%',
        width: '100%',
        // `origin` + `enablejsapi` make YouTube's embed referer/JS-API check pass
        // — without them some embeddable videos wrongly fail with 150/153 from a
        // non-standard origin. Pairs with the page Referrer-Policy header.
        playerVars: {
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            setReady(true); // re-runs the track-load effect if state arrived first
            // Apply the authoritative volume immediately (and unmute if audible);
            // the [effectiveVolume] effect won't re-fire just because we became ready.
            if (playerRef.current) applyVolume(playerRef.current, volumeRef.current);
          },
          onStateChange: (event) => {
            // Auto-advance: when the current video ends, tell the server.
            if (event.data === window.YT?.PlayerState.ENDED) {
              if (endedRef.current) return;
              endedRef.current = true;
              void actions.trackEnded();
            } else {
              // Any non-ENDED state (e.g. a freshly-loaded next track) re-arms.
              endedRef.current = false;
            }
            // Successful playback clears any local error banner.
            if (event.data === window.YT?.PlayerState.PLAYING) {
              setErrorCode(null);
              // A newly-started video can reset to muted/default volume — reapply.
              if (playerRef.current) applyVolume(playerRef.current, volumeRef.current);
            }
          },
          onError: (event) => {
            // Surface locally + report to the room (player-only status), tagging
            // the failed videoId so the server can ignore a stale error.
            setErrorCode(event.data);
            void actions.playbackError(event.data, trackIdRef.current ?? undefined);
          },
        },
      });
    }

    if (window.YT?.Player) {
      createPlayer();
    } else {
      window.onYouTubeIframeAPIReady = createPlayer;
      if (!document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
        const script = document.createElement('script');
        script.src = IFRAME_API_SRC;
        document.head.appendChild(script);
      }
    }
  }, []);

  // Apply authoritative state to the player.
  const trackId = currentTrack?.id ?? null;
  const isPlaying = stateIsPlaying;
  const volume = stateVolume;
  // Per-track loudness gain (absent ⇒ 1.0); attenuates the applied volume.
  const gain = currentTrack ? (trackGain[currentTrack.id] ?? 1) : 1;

  // Keep the failed-error tagging ref in sync with the current track.
  useEffect(() => {
    trackIdRef.current = trackId;
  }, [trackId]);

  // Load the current track. Depends on `ready` too so that when the room state
  // arrives BEFORE the player is ready, becoming ready re-runs this and loads.
  useEffect(() => {
    if (!playerRef.current || !ready || !trackId) return;
    endedRef.current = false;
    // RESUME PLAYBACK: if the latest known position belongs to THIS track and is
    // past a small threshold, (re)load from that offset — e.g. after a Player
    // reconnect / server restart. On a fresh changeTrack to a NEW id the
    // progress.id won't match (it still holds the previous track), so this never
    // accidentally rewinds an intentional track change.
    const p = progressRef.current;
    if (p && p.id === trackId && p.currentTime > 5) {
      playerRef.current.loadVideoById({ videoId: trackId, startSeconds: p.currentTime });
    } else {
      playerRef.current.loadVideoById(trackId);
    }
  }, [trackId, ready]);

  useEffect(() => {
    if (!playerRef.current || !ready) return;
    if (isPlaying) playerRef.current.playVideo();
    else playerRef.current.pauseVideo();
  }, [isPlaying, ready]);

  // Effective applied volume (master × per-track gain), mirrored to a ref so
  // onReady can apply it once the player exists (the effect below runs before
  // the player is ready and otherwise never re-fires until volume/gain change).
  const effectiveVolume = Math.max(0, Math.min(100, Math.round(volume * gain)));
  const volumeRef = useRef(effectiveVolume);
  useEffect(() => {
    volumeRef.current = effectiveVolume;
  }, [effectiveVolume]);

  /** Apply the effective volume, unmuting when audible — mobile starts muted. */
  function applyVolume(p: YTPlayer, effective: number) {
    p.setVolume(effective);
    // setVolume alone is silent while muted (mobile autoplay); reconcile mute.
    // Guard the mute API defensively — never let a missing method break playback.
    if (typeof p.isMuted !== 'function') return;
    if (effective > 0) {
      if (p.isMuted()) p.unMute?.();
    } else if (!p.isMuted()) {
      p.mute?.();
    }
  }

  useEffect(() => {
    if (!playerRef.current || !readyRef.current) return;
    applyVolume(playerRef.current, effectiveVolume);
  }, [effectiveVolume]);

  // Report playback progress (~every 2s) while a track is loaded and ready.
  useEffect(() => {
    if (!trackId) return;
    const interval = setInterval(() => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      const duration = p.getDuration();
      const currentTime = p.getCurrentTime();
      // Skip until the player has real numbers (duration 0/NaN = not loaded yet).
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;
      void actions.progress(currentTime, duration);
    }, 2000);
    return () => clearInterval(interval);
  }, [trackId]);

  // Apply controller seeks: only when the server pushes a NEW lastSeek (ts changes).
  useEffect(() => {
    if (!lastSeek) return;
    if (lastSeekTsRef.current === lastSeek.ts) return;
    lastSeekTsRef.current = lastSeek.ts;
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    p.seekTo(lastSeek.seconds, true);
  }, [lastSeek]);

  if (lastError === 'wrong password') {
    return (
      <main className="flex min-h-screen items-center justify-center px-5 text-center">
        <p className="text-base text-red-400">비밀번호가 올바르지 않습니다</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-5 py-8">
      <div className="text-center">
        <p className="text-sm text-neutral-400">방 코드 · 플레이어 (메인)</p>
        <p className="text-5xl font-bold tracking-[0.2em]">{room || '—'}</p>
        <p className="mt-2 text-sm text-neutral-500">이 코드로 리모컨에서 접속</p>
      </div>

      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {errorCode !== null && (
        <div className="flex flex-col gap-3 rounded-xl bg-red-950/60 p-4 text-sm text-red-300">
          <p className="font-semibold">
            ⚠ {playbackErrorMessage(errorCode)} (코드 {errorCode})
          </p>
          <button
            type="button"
            onClick={() => {
              if (currentTrack) playerRef.current?.loadVideoById(currentTrack.id);
            }}
            className="self-start rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-neutral-950"
          >
            다시 시도
          </button>
        </div>
      )}

      <ControlPanel variant="main" />

      <p className="text-center text-sm">
        <span className={connected ? 'text-emerald-400' : 'text-neutral-500'}>
          {connected ? '연결됨' : '연결 중…'}
        </span>
      </p>
    </main>
  );
}

export default function PlayerPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center text-neutral-500">
          로딩 중…
        </main>
      }
    >
      <PlayerInner />
    </Suspense>
  );
}
