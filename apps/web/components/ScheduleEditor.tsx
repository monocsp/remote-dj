'use client';

import { type Ack, type DayKey, type WeeklySchedule, isHHMM } from '@remote-dj/shared';
import { useEffect, useState } from 'react';

// Day rows in display order (mon→sun) with Korean labels.
const DAY_ROWS: { key: DayKey; label: string }[] = [
  { key: 'mon', label: '월' },
  { key: 'tue', label: '화' },
  { key: 'wed', label: '수' },
  { key: 'thu', label: '목' },
  { key: 'fri', label: '금' },
  { key: 'sat', label: '토' },
  { key: 'sun', label: '일' },
];

/** Default schedule: weekdays on 09:00–18:00, weekend off (office use-case). */
function defaultSchedule(): WeeklySchedule {
  return {
    enabled: false,
    days: {
      mon: { on: true, start: '09:00', end: '18:00' },
      tue: { on: true, start: '09:00', end: '18:00' },
      wed: { on: true, start: '09:00', end: '18:00' },
      thu: { on: true, start: '09:00', end: '18:00' },
      fri: { on: true, start: '09:00', end: '18:00' },
      sat: { on: false, start: '09:00', end: '18:00' },
      sun: { on: false, start: '09:00', end: '18:00' },
    },
  };
}

interface ScheduleEditorProps {
  schedule: WeeklySchedule | null;
  onSave: (schedule: WeeklySchedule) => Promise<Ack>;
}

/**
 * Reusable editable weekly-schedule editor (예약 재생). The schedule is a device
 * setting that lives on the Player. Local draft committed by the 저장 button
 * (not per keystroke); synced from the authoritative `schedule` prop, falling
 * back to the office default.
 */
export function ScheduleEditor({ schedule, onSave }: ScheduleEditorProps) {
  const [draft, setDraft] = useState<WeeklySchedule>(defaultSchedule);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    setDraft(schedule ?? defaultSchedule());
  }, [schedule]);

  return (
    <section className="rounded-xl bg-neutral-900 p-4">
      <h2 className="text-sm font-semibold text-neutral-300">자동 재생 예약</h2>
      <p className="mt-1 text-xs text-neutral-400">
        이 플레이어가 정한 요일·시각에 음악을{' '}
        <b className="text-neutral-200">자동으로 켜고 끕니다.</b>
      </p>
      <p className="mt-0.5 text-xs text-neutral-500">
        예: 평일 09:00 켜짐 · 18:00 꺼짐 / 주말은 체크 해제 → 종일 꺼짐
      </p>
      <label className="mt-3 flex min-h-[44px] items-center gap-3 py-2 text-sm text-neutral-200">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          className="h-6 w-6 accent-emerald-500"
        />
        자동 켜기/끄기 사용
      </label>

      {/* column header: clarify the two time fields mean turn-on / turn-off */}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="w-10 shrink-0">요일</span>
        <span className="flex-1">켜는 시각</span>
        <span className="w-3 shrink-0" />
        <span className="flex-1">끄는 시각</span>
      </div>

      <ul className="mt-1 flex flex-col gap-1.5">
        {DAY_ROWS.map(({ key, label }) => {
          const day = draft.days[key];
          return (
            <li key={key} className="flex min-h-[36px] items-center gap-2 text-xs">
              <label className="flex w-10 shrink-0 items-center gap-1.5 text-neutral-200">
                <input
                  type="checkbox"
                  checked={day.on}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      days: { ...d.days, [key]: { ...d.days[key], on: e.target.checked } },
                    }))
                  }
                  className="h-5 w-5 accent-emerald-500"
                />
                {label}
              </label>
              <input
                type="time"
                value={day.start}
                disabled={!day.on}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    days: { ...d.days, [key]: { ...d.days[key], start: e.target.value } },
                  }))
                }
                className="min-h-[36px] flex-1 rounded-lg bg-neutral-800 px-2 text-neutral-100 disabled:opacity-40"
              />
              <span className="text-neutral-500">–</span>
              <input
                type="time"
                value={day.end}
                disabled={!day.on}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    days: { ...d.days, [key]: { ...d.days[key], end: e.target.value } },
                  }))
                }
                className="min-h-[36px] flex-1 rounded-lg bg-neutral-800 px-2 text-neutral-100 disabled:opacity-40"
              />
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => {
          const invalid = DAY_ROWS.some(({ key }) => {
            const d = draft.days[key];
            if (!d.on) return false;
            return !isHHMM(d.start) || !isHHMM(d.end) || d.start >= d.end;
          });
          if (invalid) {
            setHint("켜진 요일은 '켜짐' 시각이 '꺼짐'보다 빨라야 해요");
            return;
          }
          setHint(null);
          void onSave(draft).then((ack) => {
            if (!ack.ok) setHint(ack.error ?? '저장 실패');
          });
        }}
        className="mt-3 min-h-[44px] w-full rounded-lg bg-emerald-500 px-4 text-sm font-bold text-neutral-950"
      >
        예약 저장
      </button>
      {hint && <p className="mt-2 text-xs text-red-400">{hint}</p>}
      <p className="mt-2 text-xs text-neutral-500">
        이 기기(서버)의 시간 기준으로 자동 동작합니다.
      </p>
    </section>
  );
}
