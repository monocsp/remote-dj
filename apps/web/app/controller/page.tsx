'use client';

import { ActivityFeed } from '@/components/ActivityFeed';
import { ChangeTrackForm } from '@/components/ChangeTrackForm';
import { useRoom } from '@/lib/useRoom';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

function ControllerInner() {
  const params = useSearchParams();
  const room = params.get('room') ?? '';
  const nick = params.get('nick') ?? undefined;

  const { state, log, connected, changeTrack, setVolume, togglePlay } = useRoom(
    room,
    'controller',
    nick,
  );

  // Local mirror of the volume slider; synced to authoritative state.
  const [vol, setVol] = useState(100);
  const stateVolume = state?.volume;
  useEffect(() => {
    if (stateVolume !== undefined) setVol(stateVolume);
  }, [stateVolume]);

  const isPlaying = state?.isPlaying ?? false;
  const track = state?.currentTrack ?? null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs text-neutral-500">방 코드</p>
          <p className="text-2xl font-bold tracking-[0.2em]">{room || '—'}</p>
        </div>
        <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-neutral-500'}`}>
          {connected ? '연결됨' : '연결 중…'}
        </span>
      </header>

      {/* now-playing card */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <p className="text-xs uppercase tracking-wide text-neutral-500">현재 곡</p>
        <p className="mt-1 text-lg font-semibold">
          {track?.title ?? (track ? '(제목 없음)' : '재생 중인 곡 없음')}
        </p>
        {track?.url && (
          <a
            href={track.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block truncate text-xs text-emerald-400"
          >
            {track.url}
          </a>
        )}
      </section>

      {/* change-track form */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">곡 변경</h2>
        <ChangeTrackForm onSubmit={changeTrack} />
      </section>

      {/* volume + play/pause */}
      <section className="flex flex-col gap-4 rounded-xl bg-neutral-900 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-neutral-300">음량</span>
            <span className="font-mono text-neutral-400">{vol}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            onChange={(e) => setVol(Number(e.target.value))}
            onPointerUp={() => void setVolume(vol)}
            className="w-full accent-emerald-500"
          />
        </div>
        <button
          type="button"
          onClick={() => void togglePlay(!isPlaying)}
          className="rounded-lg bg-emerald-500 px-4 py-3 text-base font-bold text-neutral-950"
        >
          {isPlaying ? '일시정지' : '재생'}
        </button>
      </section>

      {/* activity log */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">Activity Log</h2>
        <ActivityFeed entries={log} />
      </section>
    </main>
  );
}

export default function ControllerPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center text-neutral-500">
          로딩 중…
        </main>
      }
    >
      <ControllerInner />
    </Suspense>
  );
}
