/**
 * Mobile-G2A-Hardening: レート制限（isolateローカル、ベストエフォート）の基本動作確認。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __resetRateLimitForTests, checkRateLimit } from "../src/auth/rateLimit.ts";
import { getClientIp } from "../src/auth/clientIp.ts";
import { Hono } from "hono";

beforeEach(() => {
  __resetRateLimitForTests();
});

describe("checkRateLimit", () => {
  it("上限までは許可し、超えたら拒否する", () => {
    const key = "test-key-1";
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5, 60_000)).toBe(true);
    }
    expect(checkRateLimit(key, 5, 60_000)).toBe(false);
  });

  it("ウィンドウが切り替わればカウントがリセットされる", () => {
    const key = "test-key-2";
    expect(checkRateLimit(key, 1, 50)).toBe(true);
    expect(checkRateLimit(key, 1, 50)).toBe(false);
  });

  it("異なるキーは独立してカウントされる", () => {
    expect(checkRateLimit("a", 1, 60_000)).toBe(true);
    expect(checkRateLimit("b", 1, 60_000)).toBe(true);
    expect(checkRateLimit("a", 1, 60_000)).toBe(false);
    expect(checkRateLimit("b", 1, 60_000)).toBe(false);
  });
});

describe("getClientIp", () => {
  it("CF-Connecting-IPを優先して使う", async () => {
    const app = new Hono();
    app.get("/", (c) => c.text(getClientIp(c)));

    const res = await app.request("/", { headers: { "CF-Connecting-IP": "203.0.113.5" } });
    expect(await res.text()).toBe("203.0.113.5");
  });

  it("X-Forwarded-Forは信用しない（CF-Connecting-IPが無い場合はlocal-devにフォールバック）", async () => {
    const app = new Hono();
    app.get("/", (c) => c.text(getClientIp(c)));

    const res = await app.request("/", { headers: { "X-Forwarded-For": "1.2.3.4" } });
    expect(await res.text()).toBe("local-dev");
  });

  it("CF-Connecting-IPが無ければlocal-dev", async () => {
    const app = new Hono();
    app.get("/", (c) => c.text(getClientIp(c)));

    const res = await app.request("/");
    expect(await res.text()).toBe("local-dev");
  });
});
