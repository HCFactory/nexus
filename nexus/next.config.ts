import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    // Server Function calls are logged with their arguments by default, which
    // printed secrets typed in Admin (BC client secret, Bill.com password,
    // Stripe keys) into the server log. Never log them.
    serverFunctions: false,
  },
  experimental: {
    // Reuse a page visited in the last 30 s (e.g. Back from a customer profile
    // to the customers list) instead of loading it again. Saves in Nexus call
    // revalidatePath / router.refresh, which still show changes at once.
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
