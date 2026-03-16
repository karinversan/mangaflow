import type { NextConfig } from "next";

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
let apiOrigin = "http://localhost:8000";
try {
  apiOrigin = new URL(configuredApiUrl).origin;
} catch {
  apiOrigin = "http://localhost:8000";
}

const connectSrc = Array.from(new Set(["'self'", "http://localhost:8000", apiOrigin, "ws:", "wss:"])).join(" ");

const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  `connect-src ${connectSrc}`,
  "font-src 'self' data:",
  "frame-ancestors 'none'"
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp }
        ]
      }
    ];
  }
};

export default nextConfig;
