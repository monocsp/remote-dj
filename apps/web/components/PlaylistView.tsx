'use client';

import type { Track } from '@remote-dj/shared';
import { useState } from 'react';

/** Format an epoch-ms timestamp as a Korean relative time (초/분/시간 전). */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

/**
 * The single unified playlist. One ordered list with the current track marked by
 * `currentIndex`:
 *  - played (index < current): faded + compact
 *  - current (index === current): bold + tall (the now-playing row)
 *  - upcoming (index > current): full opacity + compact
 * Each non-current row has a ✕ delete (gated by `canRemove`, confirmed via a
 * dialog). When `onJump` is provided (MAIN only) tapping a non-current row jumps
 * the cursor to it. The current row is never deletable and never a jump target.
 */
export function PlaylistView({
  playlist,
  currentIndex,
  blockedIds = [],
  canRemove,
  onRemove,
  onJump,
}: {
  playlist: Track[];
  currentIndex: number;
  blockedIds?: string[];
  canRemove: (item: Track) => boolean;
  onRemove: (index: number) => void;
  onJump?: (index: number) => void;
}) {
  // Index pending a delete confirmation (null = no dialog). We keep the item too
  // so the dialog text survives if the list shifts under us.
  const [pending, setPending] = useState<{ index: number; item: Track } | null>(null);

  if (playlist.length === 0) {
    return <p className="py-6 text-center text-sm text-neutral-500">재생목록이 비어 있습니다.</p>;
  }

  return (
    <>
      <ul className="flex flex-col">
        {playlist.map((item, index) => {
          const isCurrent = index === currentIndex;
          const isPlayed = index < currentIndex;
          const isBlocked = blockedIds.includes(item.id);
          const removable = !isCurrent && canRemove(item);
          // A blocked (unplayable) track is never a jump target — it would just
          // error and auto-skip again.
          const jumpable = !isCurrent && !isBlocked && !!onJump;
          // Per-state sizing: current is tall/bold; others are compact; played fades.
          const rowCls = isCurrent
            ? 'py-3 ring-1 ring-emerald-500/40 bg-emerald-500/5 rounded-lg my-1'
            : `py-1.5 ${isBlocked ? 'opacity-60' : isPlayed ? 'opacity-50' : ''}`;
          const thumbCls = isCurrent ? 'w-20' : 'w-12';
          const titleCls = isCurrent
            ? 'text-base font-bold text-neutral-50'
            : `text-sm ${isBlocked ? 'text-neutral-400 line-through' : 'text-neutral-200'}`;
          const label = item.title ?? '이 곡';
          // Shared row content (thumbnail + title + meta).
          const inner = (
            <>
              <div
                className={`${thumbCls} relative aspect-video shrink-0 overflow-hidden rounded-md bg-neutral-800`}
              >
                <img
                  src={`https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`}
                  loading="lazy"
                  className={`h-full w-full object-cover ${isBlocked ? 'grayscale' : ''}`}
                  alt=""
                />
                {isCurrent && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-emerald-300">
                    ♪
                  </span>
                )}
                {isBlocked && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-base">
                    🚫
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`line-clamp-2 ${titleCls}`}>{item.title ?? '(제목 없음)'}</p>
                {isBlocked ? (
                  <p className="mt-0.5 truncate text-xs font-semibold text-amber-400">
                    ⚠ 재생 불가 · 임베드(퍼가기) 비활성 영상 — 자동 건너뜀
                  </p>
                ) : (
                  <p className="mt-0.5 truncate text-xs text-neutral-500">
                    {isPlayed ? '재생함' : isCurrent ? '재생 중' : '대기'} · 추가:{' '}
                    {item.addedBy ?? '익명'} · {relativeTime(item.addedAt)}
                  </p>
                )}
              </div>
            </>
          );
          return (
            <li
              key={`${item.id}-${index}`}
              data-testid="queue-item"
              data-id={item.id}
              data-state={isCurrent ? 'current' : isPlayed ? 'played' : 'upcoming'}
              className={`flex items-center gap-3 px-2 ${rowCls}`}
            >
              {/* Tap to jump (MAIN only). Guests get a plain, non-interactive row. */}
              {jumpable ? (
                <button
                  type="button"
                  onClick={() => onJump?.(index)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-label={`${label} 재생`}
                >
                  {inner}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-3">{inner}</div>
              )}
              {removable && (
                <button
                  type="button"
                  onClick={() => setPending({ index, item })}
                  aria-label={`${label} 제거`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center text-neutral-400 transition hover:text-white"
                >
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
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          {/* backdrop wrapper — must NOT be aria-hidden or it would hide the dialog */}
          {/* `static` overrides the UA dialog default (position:absolute), which
              otherwise escapes the flex box and pins the dialog to the top-left. */}
          <dialog
            open
            aria-label="재생목록에서 삭제 확인"
            data-testid="remove-confirm"
            className="static m-0 w-full max-w-sm rounded-xl bg-neutral-900 p-5 text-left ring-1 ring-neutral-700"
          >
            <p className="text-base font-semibold text-neutral-100">삭제하시겠습니까?</p>
            <p className="mt-2 line-clamp-2 text-sm text-neutral-400">
              {pending.item.title ?? '(제목 없음)'}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="min-h-[44px] flex-1 rounded-lg bg-neutral-800 px-4 text-sm font-bold text-neutral-200"
              >
                취소
              </button>
              <button
                type="button"
                data-testid="remove-confirm-ok"
                onClick={() => {
                  // Resolve the LATEST index by track identity — the list may have
                  // shifted (another client removed an earlier item) while the
                  // dialog was open, so the captured index could be stale.
                  const i = playlist.findIndex(
                    (t) =>
                      t.id === pending.item.id &&
                      t.addedAt === pending.item.addedAt &&
                      t.ownerId === pending.item.ownerId,
                  );
                  if (i >= 0) onRemove(i);
                  setPending(null);
                }}
                className="min-h-[44px] flex-1 rounded-lg bg-red-500 px-4 text-sm font-bold text-neutral-950"
              >
                삭제
              </button>
            </div>
          </dialog>
        </div>
      )}
    </>
  );
}
