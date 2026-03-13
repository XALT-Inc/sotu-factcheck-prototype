export class RingBuffer<T> {
  private items: (T | undefined)[];
  private capacity: number;
  private writeIndex = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.items = new Array(this.capacity);
  }

  get length(): number { return this.count; }

  push(item: T): void {
    this.items[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.items = new Array(this.capacity);
    this.writeIndex = 0;
    this.count = 0;
  }

  /** Returns items in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) return this.items.slice(0, this.count) as T[];
    const result = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.items[(this.writeIndex + i) % this.capacity] as T;
    }
    return result;
  }

  slice(start?: number, end?: number): T[] {
    return this.toArray().slice(start, end);
  }

  filter(fn: (item: T) => boolean): T[] {
    return this.toArray().filter(fn);
  }
}
