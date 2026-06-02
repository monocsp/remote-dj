'use client';

import { reportError } from '@/lib/clientLog';
import { useEffect } from 'react';

/**
 * Route-segment error boundary. Reports the error to the server, then shows a
 * minimal recovery UI with a retry. `digest` is React's server-error correlation id.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, {
      event: 'runtime.route_error',
      error: { name: error.name, message: error.message, stack: error.stack, digest: error.digest },
    });
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-center text-neutral-100">
      <p className="text-base font-semibold">문제가 발생했어요</p>
      <p className="text-sm text-neutral-400">잠시 후 다시 시도해 주세요.</p>
      <button
        type="button"
        onClick={reset}
        className="min-h-[44px] rounded-lg bg-emerald-500 px-5 text-sm font-bold text-neutral-950"
      >
        다시 시도
      </button>
    </div>
  );
}
