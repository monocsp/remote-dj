'use client';

import type { Track } from '@remote-dj/shared';

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
 * YouTube-style queue list for mobile. Each row shows a 16:9 thumbnail, a
 * 2-line title clamp, and an 추가 meta line. A ✕ remove button is shown only
 * when `canRemove(item)` is true.
 */
export function QueueList({
  items,
  canRemove,
  onRemove,
}: {
  items: Track[];
  canRemove: (item: Track) => boolean;
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) {
    return <p className="py-4 text-center text-sm text-neutral-400">대기열이 비어 있습니다.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item, index) => (
        <li
          key={`${item.id}-${index}`}
          data-testid="queue-item"
          data-id={item.id}
          className="flex items-center gap-3"
        >
          <div className="w-24 aspect-video shrink-0 overflow-hidden rounded-md bg-neutral-800">
            <img
              src={`https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`}
              loading="lazy"
              className="h-full w-full object-cover"
              alt=""
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm text-neutral-200">{item.title ?? '(제목 없음)'}</p>
            <p className="mt-1 text-xs text-neutral-400">
              추가: {item.addedBy ?? '익명'} · {relativeTime(item.addedAt)}
            </p>
          </div>
          {canRemove(item) && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label="제거"
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
      ))}
    </ul>
  );
}
