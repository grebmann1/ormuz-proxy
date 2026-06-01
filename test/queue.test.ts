import { describe, expect, it } from "vitest";

import { BoundedQueue } from "../src/queue.js";

describe("BoundedQueue", () => {
  it("enqueues and dequeues in FIFO order", () => {
    const q = new BoundedQueue<number>(10);
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(q.size()).toBe(3);
    expect(q.dequeue()).toBe(1);
    expect(q.dequeue()).toBe(2);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBeUndefined();
  });

  it("enqueueFront jumps the queue", () => {
    const q = new BoundedQueue<string>(10);
    q.enqueue("a");
    q.enqueue("b");
    q.enqueueFront("priority");
    expect(q.dequeue()).toBe("priority");
    expect(q.dequeue()).toBe("a");
  });

  it("reports full at maxDepth", () => {
    const q = new BoundedQueue<number>(2);
    expect(q.isFull()).toBe(false);
    q.enqueue(1);
    expect(q.isFull()).toBe(false);
    q.enqueue(2);
    expect(q.isFull()).toBe(true);
  });

  it("clears all items", () => {
    const q = new BoundedQueue<number>(10);
    q.enqueue(1);
    q.enqueue(2);
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  it("projects wait time from refill rate", () => {
    const q = new BoundedQueue<number>(10);
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    // 3 items at 1/sec => 3000 ms
    expect(q.projectedWaitMs(1)).toBe(3000);
    // 3 items at 0.5/sec => 6000 ms
    expect(q.projectedWaitMs(0.5)).toBe(6000);
  });

  it("returns Infinity wait when refill rate is non-positive", () => {
    const q = new BoundedQueue<number>(10);
    q.enqueue(1);
    expect(q.projectedWaitMs(0)).toBe(Number.POSITIVE_INFINITY);
    expect(q.projectedWaitMs(-1)).toBe(Number.POSITIVE_INFINITY);
  });
});
