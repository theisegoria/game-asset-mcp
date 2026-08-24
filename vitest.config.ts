import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // NOTE: this suite contains NO live-provider integration tests. Every test
    // here runs against mocks or the local filesystem, so a green run says
    // nothing about whether the provider APIs behave as this code assumes.
    // Any future integration test must guard itself on key presence and be
    // reported as SKIPPED rather than silently passing.
    reporters: ['verbose'],
    testTimeout: 20_000,
  },
});
