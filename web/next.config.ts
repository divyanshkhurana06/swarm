import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next blocks cross-origin requests to dev-only assets by default, which
  // silently breaks hydration when the dev server is reached through a tunnel
  // rather than localhost. Phones cannot use localhost -- and passkeys require
  // HTTPS -- so on-device testing always goes through a tunnel.
  //
  // Development only. Production builds are unaffected.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.app", "*.loca.lt"],
};

export default nextConfig;
