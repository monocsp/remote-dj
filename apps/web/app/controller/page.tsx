'use client';

import { ActivityFeed } from '@/components/ActivityFeed';
import { ChangeTrackForm } from '@/components/ChangeTrackForm';
import { EnqueueForm } from '@/components/EnqueueForm';
import {
  actions,
  connectRoom,
  useActivityLog,
  useConnected,
  useCurrentTrack,
  useIsPlaying,
  useLastError,
  useProgress,
  useQueue,
  useSettings,
  useVolume,
} from '@/lib/roomStore';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

/** Format a number of seconds as mm:ss. */
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ControllerInner() {
  const params = useSearchParams();
  const room = params.get('room') ?? '';
  const nick = params.get('nick') ?? undefined;

  useEffect(() => {
    const password =
      typeof window !== 'undefined'
        ? (sessionStorage.getItem(`rdj:pw:${room}`) ?? undefined)
        : undefined;
    return connectRoom(room, 'controller', nick, password);
  }, [room, nick]);

  const connected = useConnected();
  const lastError = useLastError();
  const log = useActivityLog();
  const isPlaying = useIsPlaying();
  const track = useCurrentTrack();
  const queue = useQueue();
  const settings = useSettings();
  const stateVolume = useVolume();
  const progress = useProgress();

  // Local mirror of the volume slider; synced to authoritative state.
  const [vol, setVol] = useState(100);
  useEffect(() => {
    setVol(stateVolume);
  }, [stateVolume]);

  // Local mirror of the seek bar; synced to the latest player-reported position.
  const [seekPos, setSeekPos] = useState(0);
  const progressCurrent = progress?.currentTime ?? 0;
  useEffect(() => {
    setSeekPos(progressCurrent);
  }, [progressCurrent]);
  // Duration when the player has reported real progress, else null (no bar).
  const duration = progress != null && progress.duration > 0 ? progress.duration : null;

  if (lastError === 'wrong password') {
    return (
      <main className="flex min-h-screen items-center justify-center px-5 text-center">
        <p className="text-base text-red-400">비밀번호가 올바르지 않습니다</p>
      </main>
    );
  }

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
        <ChangeTrackForm onSubmit={actions.changeTrack} />
      </section>

      {/* queue (대기열) */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-300">대기열</h2>
          <button
            type="button"
            onClick={() => void actions.nextTrack()}
            disabled={queue.length === 0}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-neutral-950 transition disabled:opacity-40"
          >
            다음 곡
          </button>
        </div>

        {queue.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-500">대기열이 비어 있습니다.</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-2">
            {queue.map((item, index) => (
              <li
                key={`${item.id}-${index}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-neutral-800/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-200">
                    {item.title ?? '(제목 없음)'}
                  </p>
                  <p className="truncate text-xs text-neutral-500">{item.url}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void actions.removeQueued(index)}
                  className="shrink-0 rounded-lg bg-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-200"
                >
                  제거
                </button>
              </li>
            ))}
          </ul>
        )}

        <EnqueueForm onSubmit={actions.enqueueTrack} />
      </section>

      {/* settings (설정) */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">설정</h2>
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={settings?.allowAnonymous ?? true}
            onChange={(e) => void actions.updateSettings({ allowAnonymous: e.target.checked })}
            className="h-4 w-4 accent-emerald-500"
          />
          익명 허용 (allowAnonymous)
        </label>
        {settings?.allowAnonymous === false && (
          <p className="mt-2 text-xs text-amber-400">닉네임이 있어야 곡을 변경할 수 있어요</p>
        )}
      </section>

      {/* volume + play/pause */}
      <section className="flex flex-col gap-4 rounded-xl bg-neutral-900 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-neutral-300">탐색</span>
            {duration != null ? (
              <span className="font-mono text-neutral-400">
                {formatTime(seekPos)} / {formatTime(duration)}
              </span>
            ) : (
              <span className="text-neutral-600">진행 정보 없음</span>
            )}
          </div>
          {duration != null && (
            <input
              type="range"
              min={0}
              max={duration}
              value={Math.min(seekPos, duration)}
              onChange={(e) => setSeekPos(Number(e.target.value))}
              onPointerUp={() => void actions.seekTo(seekPos)}
              className="w-full accent-emerald-500"
            />
          )}
        </div>
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
            onPointerUp={() => void actions.setVolume(vol)}
            className="w-full accent-emerald-500"
          />
        </div>
        <button
          type="button"
          onClick={() => void actions.togglePlay(!isPlaying)}
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
