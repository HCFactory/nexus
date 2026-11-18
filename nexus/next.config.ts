import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    // Server Function calls are logged with their arguments by default, which
    // printed secrets typed in Admin (BC client secret, Bill.com password,
    // Stripe keys) into the server log. Never log them.
    serverFunctions: false,
  },
};

export default nextConfig;
