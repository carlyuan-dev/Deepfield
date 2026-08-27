interface ToolSlot {
  limit: number;
  used: number;
}

/**
 * Atomic per-tool-identity concurrency limiter (keyed by name@version).
 * Reservation is synchronous, so concurrent execute() calls on the same
 * Runner cannot race a check-then-increment. Scoped per ToolRunner instance
 * (Utility-process single assembly); deliberately not a cross-process lock.
 */
export class ToolConcurrencyLimiter {
  #slots = new Map<string, ToolSlot>();

  /**
   * Atomically occupies one slot for the key. Returns an idempotent release
   * function, or undefined when the per-tool limit is already saturated.
   */
  acquire(key: string, limit: number): (() => void) | undefined {
    if (limit < 1) {
      return undefined; // a definition must permit at least one execution
    }
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = { limit, used: 0 };
      this.#slots.set(key, slot);
    }
    if (slot.used >= slot.limit) {
      return undefined;
    }
    slot.used += 1;
    let released = false;
    return () => {
      if (released) {
        return; // never release twice
      }
      released = true;
      slot.used -= 1;
      if (slot.used <= 0) {
        this.#slots.delete(key);
      }
    };
  }
}
