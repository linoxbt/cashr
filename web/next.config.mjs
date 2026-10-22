/** @type {import('next').NextConfig} */
// The Content-Security-Policy is set per request in src/middleware.ts, with a
// nonce for scripts.
const securityHeaders = [
  // Links carry secrets in the fragment and event ids in the path; never leak either.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// Event, manage and door pages are reached by private links: keep them out of search results.
const privatePages = [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [{ source: "/how-it-works", destination: "/docs#how-it-works", permanent: true }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/(e|manage|door)/:path*", headers: privatePages },
    ];
  },
};

export default nextConfig;
