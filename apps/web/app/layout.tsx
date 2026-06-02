import { ErrorReporter } from '@/components/ErrorReporter';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'remote-dj',
  description: '협업형 음악 컨트롤러 — Player 폰이 재생, Controller가 원격 조작',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <ErrorReporter />
        {children}
      </body>
    </html>
  );
}
