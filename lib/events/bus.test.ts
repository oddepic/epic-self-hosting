import { describe, it, expect } from "vitest";
import { subscribe, publish } from "./bus";

describe("event bus", () => {
  it("delivers published events to a subscriber", () => {
    const received: { event: string; data: unknown }[] = [];
    const unsubscribe = subscribe((event, data) => received.push({ event, data }));

    publish("availability-updated", { reason: "test" });
    unsubscribe();

    expect(received).toEqual([{ event: "availability-updated", data: { reason: "test" } }]);
  });

  it("delivers to every subscriber", () => {
    let a = 0;
    let b = 0;
    const unsubscribeA = subscribe(() => a++);
    const unsubscribeB = subscribe(() => b++);

    publish("x", null);
    unsubscribeA();
    unsubscribeB();

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("stops delivering after unsubscribing", () => {
    let count = 0;
    const unsubscribe = subscribe(() => count++);

    publish("x", null);
    unsubscribe();
    publish("x", null);

    expect(count).toBe(1);
  });

  it("keeps other subscribers alive when one listener throws", () => {
    let count = 0;
    const unsubscribeBad = subscribe(() => {
      throw new Error("boom");
    });
    const unsubscribeGood = subscribe(() => count++);

    expect(() => publish("x", null)).not.toThrow();
    unsubscribeBad();
    unsubscribeGood();

    expect(count).toBe(1);
  });
});
