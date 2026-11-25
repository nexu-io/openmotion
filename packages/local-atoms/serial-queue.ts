/**
 * Serial Mutation Queue (K7).
 *
 * FIFO async mutex ensuring at most ONE host-mutating atomic call executes at a
 * time across `atom.exec` (mutating), `atom.installComponent`, `atom.credential`
 * (mutating), and `atom.config` (write/restore).
 *
 * Read-only operations (`atom.detect`, `atom.config.read`, non-mutating
 * `atom.exec`) bypass this queue so they never block one another.
 */

type QueueEntry = {
  label?: string;
  execute: () => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
};

export class SerialMutationQueue {
  private readonly pending: QueueEntry[] = [];
  private running = false;
  private currentLabel: string | undefined;

  isBusy(): boolean {
    return this.running;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  activeLabel(): string | undefined {
    return this.currentLabel;
  }

  enqueue<T>(operation: () => Promise<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        label,
        execute: async () => {
          try {
            return { ok: true, value: await operation() };
          } catch (error) {
            return { ok: false, error };
          }
        },
        settle: outcome => {
          if (outcome.ok) {
            resolve(outcome.value as T);
          } else {
            reject(outcome.error);
          }
        },
      };
      this.pending.push(entry);
      if (!this.running) {
        void this.drain();
      }
    });
  }

  async tryEnqueue<T>(
    operation: () => Promise<T>,
    label?: string,
  ): Promise<{ acquired: true; value: T } | { acquired: false; activeLabel?: string }> {
    if (this.running || this.pending.length > 0) {
      return { acquired: false, activeLabel: this.currentLabel };
    }
    const value = await this.enqueue(operation, label);
    return { acquired: true, value };
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.currentLabel = next.label;
        const outcome = await next.execute();
        if (this.pending.length === 0) {
          this.currentLabel = undefined;
          this.running = false;
        }
        next.settle(outcome);
        if (this.pending.length > 0) {
          this.running = true;
        }
      }
    } finally {
      if (this.pending.length === 0) {
        this.currentLabel = undefined;
        this.running = false;
      }
    }
  }
}

export function createSerialMutationQueue(): SerialMutationQueue {
  return new SerialMutationQueue();
}
