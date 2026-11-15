import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../../src/middleware/auth.ts";
import { config } from "../../src/config.ts";

const app = new Hono();
app.get("/ping", authMiddleware, (c) => c.json({ uid: c.get("userId") }));

const call = (headers: Record<string, string>) => app.request("/ping", { headers });

describe("authMiddleware", () => {
  test("无 token → 401", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  test("错误 token → 401", async () => {
    const res = await call({ authorization: "Bearer wrong", "x-user-id": "u1" });
    expect(res.status).toBe(401);
  });

  test("token 合法但 X-User-Id 缺失/非法 → 401", async () => {
    for (const uid of ["", "bad uid!", "a".repeat(65), "../etc"]) {
      const res = await call({ authorization: `Bearer ${config.serviceTokens[0]}`, "x-user-id": uid });
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("INVALID_USER_ID");
    }
  });

  test("双 token 轮换窗口：两个都在册的 token 均可通过", async () => {
    for (const tok of config.serviceTokens) {
      const res = await call({ authorization: `Bearer ${tok}`, "x-user-id": "user_1" });
      expect(res.status).toBe(200);
      expect((await res.json()).uid).toBe("user_1");
    }
  });

  test("合法 uid 字符集（字母数字下划线连字符，1-64）", async () => {
    const res = await call({ authorization: `Bearer ${config.serviceTokens[0]}`, "x-user-id": "A-z_09-42" });
    expect(res.status).toBe(200);
  });
});
