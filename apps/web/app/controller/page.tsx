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
  usePlaybackError,
  useProgress,
  useQueue,
  useRepeat,
  useSettings,
  useShuffle,
  useTrackGain,
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
  const trackGain = useTrackGain();
  const progress = useProgress();
  const playbackError = usePlaybackError();
  const stateRepeat = useRepeat();
  const stateShuffle = useShuffle();

  // Local mirror of the volume slider; synced to authoritative state.
  const [vol, setVol] = useState(100);
  useEffect(() => {
    setVol(stateVolume);
  }, [stateVolume]);

  // Optimistic mirror of the current track's loudness gain (percent), synced to
  // authoritative state; only meaningful when a track is loaded.
  const [gainPct, setGainPct] = useState(100);
  const curGain = track ? Math.round((trackGain[track.id] ?? 1) * 100) : 100;
  useEffect(() => {
    setGainPct(curGain);
  }, [curGain]);

  // Local mirror of the seek bar; synced to the latest player-reported position.
  const [seekPos, setSeekPos] = useState(0);
  const progressCurrent = progress?.currentTime ?? 0;
  useEffect(() => {
    setSeekPos(progressCurrent);
  }, [progressCurrent]);

  // Optimistic mirror of the allowAnonymous toggle so the checkbox flips
  // immediately on tap (the server round-trip then confirms it).
  const [anon, setAnon] = useState(true);
  const settingsAnon = settings?.allowAnonymous ?? true;
  useEffect(() => {
    setAnon(settingsAnon);
  }, [settingsAnon]);
  // Optimistic mirrors of repeat mode + shuffle so the buttons flip instantly.
  const [repeat, setRepeat] = useState<'off' | 'one' | 'all'>('off');
  useEffect(() => {
    setRepeat(stateRepeat);
  }, [stateRepeat]);
  const [shuffle, setShuffle] = useState(false);
  useEffect(() => {
    setShuffle(stateShuffle);
  }, [stateShuffle]);

  // Duration when the player has reported real progress, else null (no bar).
  const duration = progress != null && progress.duration > 0 ? progress.duration : null;

  const repeatLabel = repeat === 'off' ? '반복 끔' : repeat === 'all' ? '반복 전체' : '반복 한곡';

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
          <p className="text-xs text-neutral-400">방 코드</p>
          <p className="text-2xl font-bold tracking-[0.2em]">{room || '—'}</p>
        </div>
        <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-neutral-500'}`}>
          {connected ? '연결됨' : '연결 중…'}
        </span>
      </header>

      {/* now-playing card — primary info, visually elevated */}
      <section className="rounded-xl bg-neutral-900 p-4 ring-1 ring-emerald-500/30">
        <p className="text-xs uppercase tracking-wide text-emerald-400/80">현재 곡</p>
        <p className="mt-1 text-xl font-bold leading-snug">
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
        {playbackError && (
          <p className="mt-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs font-semibold text-red-300">
            ⚠ Player 재생 오류 (코드 {playbackError.code})
          </p>
        )}
      </section>

      {/* change-track form */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">곡 변경</h2>
        <ChangeTrackForm onSubmit={actions.changeTrack} />
      </section>

      {/* queue (대기열) */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <div className="mb-3 flex items-center justify-between gap-6">
          <h2 className="text-sm font-semibold text-neutral-300">대기열</h2>
          <button
            type="button"
            onClick={() => void actions.nextTrack()}
            disabled={queue.length === 0}
            className="min-h-[44px] rounded-lg bg-emerald-500 px-3 text-xs font-bold text-neutral-950 transition disabled:opacity-40"
          >
            다음 곡
          </button>
        </div>

        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              const next = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
              setRepeat(next);
              void actions.setRepeat(next);
            }}
            className={`min-h-[44px] flex-1 rounded-lg px-3 text-xs font-bold transition ${
              repeat !== 'off'
                ? 'bg-emerald-500 text-neutral-950'
                : 'bg-neutral-800 text-neutral-300'
            }`}
          >
            {repeatLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !shuffle;
              setShuffle(next);
              void actions.setShuffle(next);
            }}
            className={`min-h-[44px] flex-1 rounded-lg px-3 text-xs font-bold transition ${
              shuffle ? 'bg-emerald-500 text-neutral-950' : 'bg-neutral-800 text-neutral-300'
            }`}
          >
            {shuffle ? '셔플 켬' : '셔플 끔'}
          </button>
        </div>

        {queue.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-400">대기열이 비어 있습니다.</p>
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
                  <p className="truncate text-xs text-neutral-400">{item.url}</p>
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
        <label className="flex min-h-[44px] items-center gap-3 py-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={anon}
            onChange={(e) => {
              setAnon(e.target.checked);
              void actions.updateSettings({ allowAnonymous: e.target.checked });
            }}
            className="h-6 w-6 accent-emerald-500"
          />
          익명 허용 (allowAnonymous)
        </label>
        {!anon && (
          <p className="mt-2 text-xs text-amber-400">닉네임이 있어야 곡을 변경할 수 있어요</p>
        )}
      </section>

      {/* volume + play/pause */}
      <section className="flex flex-col gap-6 rounded-xl bg-neutral-900 p-4">
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
              onKeyUp={() => void actions.seekTo(seekPos)}
              className="range-touch w-full accent-emerald-500"
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
            onKeyUp={() => void actions.setVolume(vol)}
            className="range-touch w-full accent-emerald-500"
          />
        </div>
        {track && (
          <div>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-neutral-300">이 곡 음량 보정</span>
              <span className="font-mono text-neutral-400">보정 {gainPct}%</span>
            </div>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={gainPct}
              onChange={(e) => setGainPct(Number(e.target.value))}
              onPointerUp={() => void actions.setTrackGain(track.id, gainPct / 100)}
              onKeyUp={() => void actions.setTrackGain(track.id, gainPct / 100)}
              className="range-touch w-full accent-emerald-500"
            />
            <p className="mt-1 text-xs text-neutral-500">100% = 원본, 낮출수록 이 곡만 작게</p>
          </div>
        )}
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
