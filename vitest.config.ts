import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests that need real API keys guard themselves with
    // `describe.skipIf(!process.env.TRIPO_API_KEY)`; they are reported as
    // SKIPPED rather than silently passing, so a green run never implies a
    // live call was made.
    reporters: ['verbose'],
    testTimeout: 20_000,
  },
});
