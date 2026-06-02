'use client';

import { LIMITS } from '@remote-dj/shared';
import { useState } from 'react';
import { randomNickname } from '../lib/nickname';

/**
 * Controller nickname setter/changer. The nickname identifies who added a track
 * and is required to add when the room disallows anonymous. Always visible so a
 * guest can fix the "닉네임이 있어야 …" case themselves; prominent when unset.
 */
export function NicknameBar({
  nick,
  onSave,
}: {
  nick?: string;
  onSave: (nick: string) => void;
}) {
  const hasNick = !!nick && nick.trim().length > 0;
  const [editing, setEditing] = useState(!hasNick);
  // When there's no current nickname, suggest a random one the user can keep,
  // edit, or clear. Lazy initializer so it's generated once.
  const [draft, setDraft] = useState(() => nick ?? randomNickname());

  // Empty is allowed and means "go anonymous" — saving a blank name clears it.
  function save() {
    onSave(draft.trim());
    setEditing(false);
  }
  const willBeAnonymous = draft.trim().length === 0;

  if (!editing && hasNick) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm">
        <span className="min-w-0 truncate text-neutral-300">
          이름 <span className="font-semibold text-emerald-400">{nick}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setDraft(nick ?? '');
            setEditing(true);
          }}
          className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-bold text-neutral-200"
        >
          변경
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-neutral-900 p-4">
      <label className="text-sm font-semibold text-neutral-300" htmlFor="nick-input">
        이름 설정
      </label>
      <p className="mt-1 text-xs text-neutral-400">
        이름을 정하면 누가 곡을 추가했는지 표시돼요.{' '}
        <b className="text-neutral-200">비우고 저장하면 익명</b>으로 참여합니다(익명이 막힌 방에서는
        곡을 추가하려면 이름이 필요해요).
      </p>
      <div className="mt-3 flex gap-2">
        <input
          id="nick-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          maxLength={LIMITS.nickname}
          placeholder="비우면 익명"
          className="min-h-[44px] flex-1 rounded-lg bg-neutral-800 px-3 text-sm text-neutral-100 outline-none ring-emerald-500 focus:ring-2"
        />
        <button
          type="button"
          onClick={save}
          className="min-h-[44px] shrink-0 rounded-lg bg-emerald-500 px-4 text-sm font-bold text-neutral-950 transition"
        >
          {willBeAnonymous ? '익명으로' : '저장'}
        </button>
      </div>
    </div>
  );
}
