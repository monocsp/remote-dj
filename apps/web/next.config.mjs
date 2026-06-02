/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@remote-dj/shared'],
  // Hide the on-screen dev indicator (the bottom-left "N" badge).
  devIndicators: false,
  // Send a usable cross-origin referrer to the YouTube embed. A missing /
  // same-origin / no-referrer policy is a documented cause of embed errors
  // 150/153 on otherwise-embeddable videos (esp. mobile/WebView).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
    ];
  },
};

export default nextConfig;
