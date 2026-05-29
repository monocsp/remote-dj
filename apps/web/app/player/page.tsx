'use client';

import {
  actions,
  connectRoom,
  useConnected,
  useCurrentTrack,
  useIsPlaying,
  useLastError,
  useLastSeek,
  useVolume,
} from '@/lib/roomStore';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

// NOTE: YouTube login is handled in the phone's own browser session — the
// Player must be signed into YouTube in this browser for playback to work.

// Minimal typings for the YouTube IFrame Player API (loaded at runtime).
interface YTPlayer {
  loadVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  setVolume(volume: number): void;
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
  const lastSeek = useLastSeek();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  // Guard so a single playback end reports trackEnded at most once.
  const endedRef = useRef(false);
  // Last applied seek timestamp — so we only seek when the server pushes a new one.
  const lastSeekTsRef = useRef<number | null>(null);

  // Inject the IFrame API script once and build the player.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function createPlayer() {
      if (!window.YT || !containerRef.current || playerRef.current) return;
      playerRef.current = new window.YT.Player(containerRef.current, {
        height: '100%',
        width: '100%',
        playerVars: { playsinline: 1 },
        events: {
          onReady: () => {
            readyRef.current = true;
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

  useEffect(() => {
    if (!playerRef.current || !readyRef.current || !trackId) return;
    endedRef.current = false;
    playerRef.current.loadVideoById(trackId);
  }, [trackId]);

  useEffect(() => {
    if (!playerRef.current || !readyRef.current) return;
    if (isPlaying) playerRef.current.playVideo();
    else playerRef.current.pauseVideo();
  }, [isPlaying]);

  useEffect(() => {
    if (!playerRef.current || !readyRef.current) return;
    playerRef.current.setVolume(volume);
  }, [volume]);

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
        <p className="text-sm text-neutral-400">방 코드</p>
        <p className="text-5xl font-bold tracking-[0.2em]">{room || '—'}</p>
        <p className="mt-2 text-sm text-neutral-500">이 코드로 Controller에서 접속</p>
      </div>

      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <div className="rounded-xl bg-neutral-900 p-4">
        <p className="text-xs uppercase tracking-wide text-neutral-500">현재 곡</p>
        <p className="mt-1 text-lg font-semibold">
          {currentTrack?.title ?? (currentTrack ? '(제목 없음)' : '재생 중인 곡 없음')}
        </p>
      </div>

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
