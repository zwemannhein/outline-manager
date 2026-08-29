import "@testing-library/jest-dom";

// Mock environment variables for tests
process.env.ADMIN_USERNAME = "testadmin";
process.env.ADMIN_PASSWORD = "testpassword123";
process.env.JWT_SECRET = "test-secret-key-at-least-32-characters-long";
process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
// NODE_ENV is read-only, managed by vitest config
