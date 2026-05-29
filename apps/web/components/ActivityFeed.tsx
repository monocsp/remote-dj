'use client';

import type { ActivityEntry, ActivityType } from '@remote-dj/shared';

const TYPE_LABEL: Record<ActivityType, string> = {
  track_change: '곡 변경',
  volume: '음량',
  play: '재생',
  pause: '일시정지',
  settings: '설정',
  enqueue: '대기열 추가',
  dequeue: '대기열 제거',
  skip: '다음 곡',
};

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

export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-neutral-500">아직 기록이 없습니다.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {entries.map((e) => (
        <li key={e.id} className="rounded-lg bg-neutral-800/60 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-emerald-400">{e.actor ?? '익명'}</span>
            <span className="text-xs text-neutral-500">{relativeTime(e.ts)}</span>
          </div>
          <div className="mt-1 text-neutral-300">
            <span className="font-medium">{TYPE_LABEL[e.type]}</span>
            {e.reason ? <span className="text-neutral-400"> — {e.reason}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
