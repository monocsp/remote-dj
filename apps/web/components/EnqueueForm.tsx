'use client';

import { checkEmbeddable } from '@/lib/embedCheck';
import { koError } from '@/lib/errors';
import type { Ack } from '@remote-dj/shared';
import { type FormEvent, useRef, useState } from 'react';

/** Max time to wait for the server's add ack before giving up. */
const ADD_TIMEOUT_MS = 5000;

/**
 * Minimal enqueue: just a YouTube URL. No reason (removed) and no manual title —
 * the server auto-fills the title from YouTube oEmbed when it's omitted.
 *
 * While adding, the input + button are disabled and a spinner shows. The server
 * checks the link (parse / embeddable / known-bad) and acks; if it doesn't reply
 * within 5s we stop and tell the user it couldn't be added. On rejection we show
 * the reason.
 */
export function EnqueueForm({
  onSubmit,
}: {
  onSubmit: (url: string, reason?: string, title?: string) => Promise<Ack>;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const urlEmpty = url.trim().length === 0;

  // One-tap clear: wipe the field (and any error) and put the cursor back so the
  // user can immediately paste a new link — no select-all + delete dance.
  function clearUrl() {
    setUrl('');
    setError(null);
    inputRef.current?.focus();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (urlEmpty || pending) return;
    setPending(true);
    setError(null);

    // Headless preflight in THIS browser: silently try to play the link first.
    // If it's embed-disabled (150) we reject before adding. 'unknown'/'ok' both
    // proceed (server checks + play-time backstop still apply).
    const verdict = await checkEmbeddable(url.trim());
    if (verdict === 'blocked') {
      setPending(false);
      setError('추가할 수 없어요 — 임베드(퍼가기)가 비활성화된 영상이에요');
      return;
    }

    // Race the server ack against a 5s timeout so a hung check never locks the UI.
    const timeout = new Promise<Ack>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: '__timeout__' }), ADD_TIMEOUT_MS),
    );
    let ack: Ack;
    try {
      ack = await Promise.race([onSubmit(url.trim()), timeout]);
    } catch {
      ack = { ok: false, error: '__timeout__' };
    }
    setPending(false);

    if (ack.ok) {
      setUrl('');
      return;
    }
    if (ack.error === '__timeout__') {
      setError('응답이 없어 추가할 수 없어요. 잠시 후 다시 시도해 주세요.');
    } else {
      setError(`추가할 수 없어요 — ${koError(ack.error)}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="relative">
        <input
          ref={inputRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="YouTube URL 붙여넣기"
          inputMode="url"
          disabled={pending}
          className="w-full rounded-lg bg-neutral-800 py-3 pr-12 pl-3 text-sm text-neutral-100 outline-none ring-emerald-500 focus:ring-2 disabled:opacity-50"
        />
        {!urlEmpty && !pending && (
          <button
            type="button"
            onClick={clearUrl}
            aria-label="입력 지우기"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-neutral-400 transition hover:text-white"
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
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={urlEmpty || pending}
        className="flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-sm font-bold text-neutral-950 transition disabled:opacity-40"
      >
        {pending && (
          <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" />
          </svg>
        )}
        {pending ? '확인 중…' : '대기열에 추가'}
      </button>
    </form>
  );
}
