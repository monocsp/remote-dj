'use client';

import { ActivityFeed } from '@/components/ActivityFeed';
import { EnqueueForm } from '@/components/EnqueueForm';
import { PlaylistView } from '@/components/PlaylistView';
import { ScheduleEditor } from '@/components/ScheduleEditor';
import { playbackErrorMessage } from '@/lib/errors';
import {
  actions,
  useActivityLog,
  useBlockedIds,
  useCurrentIndex,
  useCurrentTrack,
  useIsPlaying,
  useMySocketId,
  usePlaybackError,
  usePlaylist,
  useRepeat,
  useSchedule,
  useSettings,
  useTrackGain,
  useVolume,
} from '@/lib/roomStore';
import type { Track } from '@remote-dj/shared';
import { type CSSProperties, useEffect, useState } from 'react';

/**
 * Controller (리모컨) activity log only shows entries from the last 5 hours —
 * the server keeps the full log, but a guest's remote view stays uncluttered.
 * The MAIN (player) sees everything.
 */
const RECENT_LOG_WINDOW_MS = 5 * 60 * 60 * 1000;

/** YouTube-style shuffle glyph (Lucide "shuffle"). */
function ShuffleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M16 3h5v5" />
      <path d="M4 20 21 3" />
      <path d="M21 16v5h-5" />
      <path d="M15 15l6 6" />
      <path d="M4 4l5 5" />
    </svg>
  );
}

/** YouTube-style repeat glyph (Lucide "repeat" / "repeat-1" when one). */
function RepeatIcon({ one }: { one?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      {one && <path d="M11 10h1v4" />}
    </svg>
  );
}

/**
 * Shared control surface for both roles, centered on the single unified
 * playlist. GUEST (리모컨) gets enqueue / volume / gain / play-pause and can
 * delete only its own playlist items. MAIN (the Player device) additionally
 * gets the main-only controls: 다음 곡 / 반복 / 셔플(shuffleQueue) / 행 탭 점프 /
 * 임의 항목 제거 / 설정(익명 허용) / 예약.
 */
export function ControlPanel({
  variant,
  myNick,
}: {
  variant: 'guest' | 'main';
  myNick?: string;
}) {
  const isMain = variant === 'main';

  const mySocketId = useMySocketId();
  const log = useActivityLog();
  const isPlaying = useIsPlaying();
  const track = useCurrentTrack();
  const playlist = usePlaylist();
  const currentIndex = useCurrentIndex();
  const blockedIds = useBlockedIds();
  const settings = useSettings();
  const stateVolume = useVolume();
  const trackGain = useTrackGain();
  const playbackError = usePlaybackError();
  const stateRepeat = useRepeat();
  const schedule = useSchedule();

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

  // Optimistic mirror of the allowAnonymous toggle so the checkbox flips
  // immediately on tap (the server round-trip then confirms it).
  const [anon, setAnon] = useState(true);
  const settingsAnon = settings?.allowAnonymous ?? true;
  useEffect(() => {
    setAnon(settingsAnon);
  }, [settingsAnon]);
  // Optimistic mirror of repeat mode so the icon flips instantly.
  const [repeat, setRepeat] = useState<'off' | 'one' | 'all'>('off');
  useEffect(() => {
    setRepeat(stateRepeat);
  }, [stateRepeat]);

  // Main can remove anything; a guest can remove only items it added (matched by
  // connection ownership, with a nickname fallback for reconnects).
  const canRemove: (item: Track) => boolean = isMain
    ? () => true
    : (item) => item.ownerId === mySocketId || (!!myNick && item.addedBy === myNick);

  // Guest sees only the last 5h of activity; main sees the full log.
  const visibleLog = isMain ? log : log.filter((e) => Date.now() - e.ts <= RECENT_LOG_WINDOW_MS);

  const upcomingCount = playlist.length - currentIndex - 1;
  const atEnd = currentIndex + 1 >= playlist.length;

  return (
    <>
      {playbackError && (
        <div className="rounded-xl bg-red-950/60 px-4 py-3 text-sm text-red-300">
          <p className="font-semibold">⚠ {playbackErrorMessage(playbackError.code)}</p>
          <p className="mt-0.5 text-xs text-red-300/80">
            코드 {playbackError.code} · 다음 곡으로 자동으로 넘어갑니다
          </p>
        </div>
      )}

      {/* 재생목록 — the single unified list (played → current → upcoming) */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-300">재생목록</h2>
          {isMain && (
            <div className="flex items-center gap-1">
              {/* repeat: icon-only, emerald when active (all/one), "1" for one */}
              <button
                type="button"
                aria-label={
                  repeat === 'off' ? '반복: 꺼짐' : repeat === 'all' ? '반복: 전체' : '반복: 한 곡'
                }
                aria-pressed={repeat !== 'off'}
                onClick={() => {
                  const next = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
                  setRepeat(next);
                  void actions.setRepeat(next);
                }}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
                  repeat !== 'off'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <RepeatIcon one={repeat === 'one'} />
              </button>
              {/* shuffle: one-shot — reorders the upcoming items (current stays) */}
              <button
                type="button"
                aria-label="다음 곡 섞기"
                disabled={upcomingCount < 2}
                onClick={() => void actions.shuffleQueue()}
                className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-200 disabled:opacity-30"
              >
                <ShuffleIcon />
              </button>
              <button
                type="button"
                onClick={() => void actions.nextTrack()}
                disabled={playlist.length === 0 || (atEnd && repeat !== 'all')}
                className="ml-1 min-h-[44px] rounded-lg bg-emerald-500 px-3 text-xs font-bold text-neutral-950 transition disabled:opacity-40"
              >
                다음 곡
              </button>
            </div>
          )}
        </div>

        <div className="mb-3">
          <PlaylistView
            playlist={playlist}
            currentIndex={currentIndex}
            blockedIds={blockedIds}
            canRemove={canRemove}
            onRemove={(i) => void actions.removeQueued(i)}
            onJump={isMain ? (i) => void actions.jumpTo(i) : undefined}
          />
        </div>

        {/* 곡 추가 — guests add often (always open); on the Player(main) it's rare,
            so it's a collapsed-by-default section. */}
        {isMain ? (
          <details className="rounded-lg bg-neutral-800/40 p-3">
            <summary className="cursor-pointer list-none text-sm font-semibold text-neutral-300">
              ＋ 곡 추가
            </summary>
            <div className="mt-3">
              <EnqueueForm onSubmit={actions.enqueueTrack} />
            </div>
          </details>
        ) : (
          <EnqueueForm onSubmit={actions.enqueueTrack} />
        )}
      </section>

      {/* transport: volume + per-track gain + play/pause — kept high so the
          most-used controls are within one-handed reach on the player. */}
      <section className="flex flex-col gap-6 rounded-xl bg-neutral-900 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-neutral-300">전체 음량</span>
            <span className="font-mono text-neutral-400">{vol}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            aria-label="전체 음량"
            onChange={(e) => setVol(Number(e.target.value))}
            onPointerUp={() => void actions.setVolume(vol)}
            onKeyUp={() => void actions.setVolume(vol)}
            style={{ '--pct': `${vol}%` } as CSSProperties}
            className="range-touch w-full"
          />
        </div>
        {track && (
          <details className="rounded-lg bg-neutral-800/40 p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-neutral-300">
              <span>이 곡만 음량 보정</span>
              <span className="font-mono text-neutral-400">{gainPct}%</span>
            </summary>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={gainPct}
              aria-label="이 곡만 음량 보정"
              onChange={(e) => setGainPct(Number(e.target.value))}
              onPointerUp={() => void actions.setTrackGain(track.id, gainPct / 100)}
              onKeyUp={() => void actions.setTrackGain(track.id, gainPct / 100)}
              style={{ '--pct': `${((gainPct - 20) / 80) * 100}%` } as CSSProperties}
              className="range-touch mt-2 w-full"
            />
            <p className="mt-1 text-xs text-neutral-400">
              100% = 원본 · 낮출수록 이 곡만 작아져요(다른 곡엔 영향 없음)
            </p>
          </details>
        )}
        <button
          type="button"
          onClick={() => void actions.togglePlay(!isPlaying)}
          className="rounded-lg bg-emerald-500 px-4 py-3 text-base font-bold text-neutral-950"
        >
          {isPlaying ? '일시정지' : '재생'}
        </button>
      </section>

      {/* settings (설정) — main only */}
      {isMain && (
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
      )}

      {/* schedule (예약) — main only, COLLAPSED by default (low-frequency, was
          dominating the player's scroll length). */}
      {isMain && (
        <details className="rounded-xl bg-neutral-900/60">
          <summary className="cursor-pointer list-none rounded-xl px-4 py-3 text-sm font-semibold text-neutral-300">
            ⏰ 자동 재생 예약{' '}
            <span className="text-xs font-normal text-neutral-500">(열기/닫기)</span>
          </summary>
          <div className="px-1 pb-1">
            <ScheduleEditor schedule={schedule} onSave={actions.setSchedule} />
          </div>
        </details>
      )}

      {/* activity log */}
      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">Activity Log</h2>
        {!isMain && <p className="mb-2 text-xs text-neutral-500">최근 5시간 기록만 표시됩니다.</p>}
        <ActivityFeed entries={visibleLog} />
      </section>
    </>
  );
}
