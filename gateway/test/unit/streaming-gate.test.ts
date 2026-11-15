import { describe, expect, test } from "bun:test";
import { StreamQueueTimeout, StreamingGate } from "../../src/core/streaming-gate.ts";

describe("StreamingGate", () => {
  test("上限内立即获得槽位，release 幂等且释放正确", async () => {
    const gate = new StreamingGate(2);
    const r1 = await gate.acquire("u1", 100);
    const r2 = await gate.acquire("u1", 100);
    expect(gate.stats()).toEqual({ held: 2, waiting: 0 });
    r1();
    r1(); // 幂等
    expect(gate.stats().held).toBe(1);
    r2();
    expect(gate.stats()).toEqual({ held: 0, waiting: 0 });
  });

  test("全局上限：满载时排队，release 唤醒", async () => {
    const gate = new StreamingGate(1);
    const r1 = await gate.acquire("u1", 100);
    let admitted = false;
    const p2 = gate.acquire("u2", 5_000).then((r) => {
      admitted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(admitted).toBeFalse();
    expect(gate.stats().waiting).toBe(1);
    r1();
    const r2 = await p2;
    expect(admitted).toBeTrue();
    expect(gate.stats()).toEqual({ held: 1, waiting: 0 });
    r2();
    expect(gate.stats().held).toBe(0);
  });

  test("每用户上限：user A 满载不阻塞 user B（防队头饿死）", async () => {
    const gate = new StreamingGate(5);
    gate.setUserLimitProvider((uid) => (uid === "uA" ? 1 : 99));
    const rA = await gate.acquire("uA", 100);
    const pB = gate.acquire("uB", 5_000);
    const pC = gate.acquire("uA", 5_000).catch((e) => e); // uA 排在 B 之后也应获得（B 先）
    const rB = await pB;
    expect(gate.stats().held).toBe(2);
    // C（uA 满载）仍排队
    let cDone = false;
    void pC.then(() => (cDone = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(cDone).toBeFalse();
    rA();
    await pC;
    expect(cDone).toBeTrue();
    rB();
  });

  test("排队超时 → StreamQueueTimeout，且不再被后续 release 唤醒", async () => {
    const gate = new StreamingGate(1);
    const r1 = await gate.acquire("u1", 100);
    const p2 = gate.acquire("u2", 60);
    await expect(p2).rejects.toBeInstanceOf(StreamQueueTimeout);
    r1();
    // 超时的等待者已被移除，释放后 gate 空闲
    expect(gate.stats()).toEqual({ held: 0, waiting: 0 });
    const r3 = await gate.acquire("u3", 100);
    r3();
  });

  test("release 唤醒按 FIFO 顺序（同用户，逐槽接力）", async () => {
    const gate = new StreamingGate(1);
    const r1 = await gate.acquire("u1", 100);
    const order: string[] = [];
    const p2 = gate.acquire("u1", 5_000).then((r) => {
      order.push("w1");
      return r;
    });
    const p3 = gate.acquire("u1", 5_000).then((r) => {
      order.push("w2");
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    r1(); // → w1 进
    const rw2 = await p2;
    expect(order).toEqual(["w1"]);
    rw2(); // → w2 进（全局=1，逐槽接力）
    const rw3 = await p3;
    expect(order).toEqual(["w1", "w2"]);
    rw3();
    expect(gate.stats().held).toBe(0);
  });

  test("userLimitProvider 可动态更新（限额热更）", async () => {
    const gate = new StreamingGate(10);
    gate.setUserLimitProvider(() => 1);
    const r1 = await gate.acquire("u1", 100);
    gate.setUserLimitProvider(() => 2); // 提额
    const r2 = await gate.acquire("u1", 100);
    expect(gate.stats().held).toBe(2);
    r1();
    r2();
  });
});
