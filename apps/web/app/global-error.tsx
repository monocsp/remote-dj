'use client';

import { reportError } from '@/lib/clientLog';
import { useEffect } from 'react';

/**
 * Top-level error boundary for failures in the root layout itself. Must render
 * its own <html>/<body>. Reports to the server before showing the fallback.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, {
      event: 'runtime.global_error',
      level: 'fatal',
      error: { name: error.name, message: error.message, stack: error.stack, digest: error.digest },
    });
  }, [error]);

  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-center text-neutral-100">
        <p className="text-base font-semibold">앱에 문제가 발생했어요</p>
        <button
          type="button"
          onClick={reset}
          className="min-h-[44px] rounded-lg bg-emerald-500 px-5 text-sm font-bold text-neutral-950"
        >
          다시 시도
        </button>
      </body>
    </html>
  );
}
