'use client';

import { type Role, generateRoomCode } from '@remote-dj/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export default function LandingPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>('controller');
  const [roomCode, setRoomCode] = useState('');
  const [nickname, setNickname] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!code) return;
    if (role === 'controller') {
      const nick = nickname.trim();
      const q = nick ? `&nick=${encodeURIComponent(nick)}` : '';
      router.push(`/controller?room=${encodeURIComponent(code)}${q}`);
    } else {
      router.push(`/player?room=${encodeURIComponent(code)}`);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">remote-dj</h1>
        <p className="mt-2 text-sm text-neutral-400">협업형 음악 컨트롤러</p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <span className="mb-2 block text-sm font-medium text-neutral-300">역할</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRole('controller')}
              className={`rounded-xl px-4 py-4 text-base font-semibold transition ${
                role === 'controller'
                  ? 'bg-emerald-500 text-neutral-950'
                  : 'bg-neutral-800 text-neutral-300'
              }`}
            >
              Controller
            </button>
            <button
              type="button"
              onClick={() => setRole('player')}
              className={`rounded-xl px-4 py-4 text-base font-semibold transition ${
                role === 'player'
                  ? 'bg-emerald-500 text-neutral-950'
                  : 'bg-neutral-800 text-neutral-300'
              }`}
            >
              Player
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="room" className="mb-2 block text-sm font-medium text-neutral-300">
            방 코드
          </label>
          <div className="flex gap-2">
            <input
              id="room"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="ABCDEF"
              autoCapitalize="characters"
              maxLength={6}
              className="w-full rounded-xl bg-neutral-800 px-4 py-4 text-center text-2xl font-bold tracking-[0.3em] uppercase outline-none ring-emerald-500 focus:ring-2"
            />
            <button
              type="button"
              onClick={() => setRoomCode(generateRoomCode())}
              className="shrink-0 rounded-xl bg-neutral-700 px-4 py-4 text-sm font-semibold text-neutral-100"
            >
              코드 생성
            </button>
          </div>
        </div>

        {role === 'controller' && (
          <div>
            <label htmlFor="nick" className="mb-2 block text-sm font-medium text-neutral-300">
              닉네임 (선택)
            </label>
            <input
              id="nick"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="익명"
              className="w-full rounded-xl bg-neutral-800 px-4 py-4 text-base outline-none ring-emerald-500 focus:ring-2"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={!roomCode.trim()}
          className="mt-2 rounded-xl bg-emerald-500 px-4 py-4 text-lg font-bold text-neutral-950 transition disabled:opacity-40"
        >
          입장
        </button>
      </form>
    </main>
  );
}
