'use client';

import { installErrorReporting } from '@/lib/clientLog';
import { useEffect } from 'react';

/**
 * Mounts once in the root layout to register global window error handlers
 * (window.onerror / unhandledrejection) and page-hide flushing. Renders nothing.
 */
export function ErrorReporter() {
  useEffect(() => {
    installErrorReporting();
  }, []);
  return null;
}
