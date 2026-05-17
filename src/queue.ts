export class BoundedQueue<T> {
  private readonly items: T[] = [];

  public constructor(private readonly maxDepth: number) {}

  public size(): number {
    return this.items.length;
  }

  public isFull(): boolean {
    return this.items.length >= this.maxDepth;
  }

  public enqueue(item: T): void {
    this.items.push(item);
  }

  public enqueueFront(item: T): void {
    this.items.unshift(item);
  }

  public dequeue(): T | undefined {
    return this.items.shift();
  }

  public clear(): void {
    this.items.length = 0;
  }

  public projectedWaitMs(refillPerSec: number): number {
    if (refillPerSec <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.ceil((this.items.length / refillPerSec) * 1000);
  }
}
