'use client';

import { ControlPanel } from '@/components/ControlPanel';
import { connectRoom, useConnected, useLastError } from '@/lib/roomStore';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

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
          <p className="text-xs text-neutral-400">방 코드 · 리모컨</p>
          <p className="text-2xl font-bold tracking-[0.2em]">{room || '—'}</p>
        </div>
        <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-neutral-500'}`}>
          {connected ? '연결됨' : '연결 중…'}
        </span>
      </header>

      <ControlPanel variant="guest" />
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
