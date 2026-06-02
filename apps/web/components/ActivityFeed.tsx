'use client';

import type { ActivityEntry, ActivityType } from '@remote-dj/shared';

const TYPE_LABEL: Record<ActivityType, string> = {
  track_change: '곡 변경',
  volume: '전체 음량',
  play: '재생',
  pause: '일시정지',
  settings: '설정',
  enqueue: '대기열 추가',
  dequeue: '대기열 제거',
  skip: '다음 곡',
  seek: '탐색',
  gain: '음량 보정',
  mode: '재생 모드',
  schedule: '예약',
  error: '재생 오류',
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

/** mm:ss for a seconds value (used by the seek detail). */
function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build a short human description of WHAT an activity acted on, from its
 * structured `detail` — e.g. which song was added/removed, what volume was set.
 * Returns null when there's nothing useful to add beyond the type label.
 */
function describeDetail(type: ActivityType, detail?: Record<string, unknown>): string | null {
  if (!detail) return null;
  // Title may be null when logged before YouTube resolved it — omit rather than
  // show "(제목 없음)" (the server backfills the title shortly after).
  const t = str(detail.title);
  switch (type) {
    case 'volume': {
      const v = num(detail.volume);
      return v == null ? null : `${v}(으)로`;
    }
    case 'enqueue':
      if (detail.requeued) return t ? `${t} (다시 추가)` : '다시 추가';
      return t;
    case 'dequeue':
      return t;
    case 'track_change':
      if (!t) return null;
      return detail.fromHistory ? `${t} (이전 곡)` : t;
    case 'skip':
      return t;
    case 'gain': {
      const g = num(detail.gain);
      return g == null ? null : `보정 ${Math.round(g * 100)}%`;
    }
    case 'seek': {
      const s = num(detail.seconds);
      return s == null ? null : `${mmss(s)}`;
    }
    case 'mode':
      if ('repeat' in detail) return `반복 ${str(detail.repeat) ?? ''}`.trim();
      if ('shuffle' in detail) return `셔플 ${detail.shuffle ? '켬' : '끔'}`;
      return null;
    case 'schedule':
      return detail.action ? `자동 ${detail.action === 'play' ? '재생' : '정지'}` : null;
    default:
      return null;
  }
}

export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-neutral-500">아직 기록이 없습니다.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {entries.map((e) => {
        const detail = describeDetail(e.type, e.detail);
        return (
          <li key={e.id} className="rounded-lg bg-neutral-800/60 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-emerald-400">{e.actor ?? '익명'}</span>
              <span className="text-xs text-neutral-500">{relativeTime(e.ts)}</span>
            </div>
            <div className="mt-1 text-neutral-300">
              <span className="font-medium">{TYPE_LABEL[e.type]}</span>
              {detail ? <span className="text-neutral-400"> · {detail}</span> : null}
              {e.reason ? <span className="text-neutral-400"> — {e.reason}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
