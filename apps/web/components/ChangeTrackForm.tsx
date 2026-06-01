'use client';

import { koError } from '@/lib/errors';
import type { Ack } from '@remote-dj/shared';
import { type FormEvent, useState } from 'react';

export function ChangeTrackForm({
  onSubmit,
}: {
  onSubmit: (url: string, reason: string, title?: string) => Promise<Ack>;
}) {
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reasonEmpty = reason.trim().length === 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (reasonEmpty || pending) return;
    setPending(true);
    setError(null);
    const ack = await onSubmit(url.trim(), reason.trim(), title.trim() || undefined);
    setPending(false);
    if (ack.ok) {
      setUrl('');
      setReason('');
      setTitle('');
    } else {
      setError(koError(ack.error));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="YouTube URL"
        inputMode="url"
        className="rounded-lg bg-neutral-800 px-3 py-3 text-sm outline-none ring-emerald-500 focus:ring-2"
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="사유 (필수)"
        className="rounded-lg bg-neutral-800 px-3 py-3 text-sm outline-none ring-emerald-500 focus:ring-2"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="제목 (선택)"
        className="rounded-lg bg-neutral-800 px-3 py-3 text-sm outline-none ring-emerald-500 focus:ring-2"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={reasonEmpty || pending}
        className="rounded-lg bg-emerald-500 px-4 py-3 text-sm font-bold text-neutral-950 transition disabled:opacity-40"
      >
        {pending ? '변경 중…' : '곡 변경'}
      </button>
    </form>
  );
}
