import type { BotListOrder } from "@rakazo/contracts";
import { resolveBotListOrder } from "@rakazo/contracts";
import { createSnoozeQueue } from "./chat-snooze.js";

/**
 * The account's sidebar order as this device shows it, for every list to read. A pick shows at
 * once and is saved in order, the newest winning; a failed save goes back to what the server
 * last said. While a pick saves, or for an answer to a request that began before it, the
 * server's word waits, so a refresh can't undo it; a later answer (another device) applies.
 */
export function createBotListOrderStore(save: (order: BotListOrder) => Promise<unknown>) {
  let queue = createSnoozeQueue();
  const listeners = new Set<() => void>();
  let server: BotListOrder | undefined;
  let chosen: BotListOrder | null = null;
  let pending = false;
  let picks = 0;
  let session = 0;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => chosen ?? server,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Call as a request starts; pass the result to `serverSaid` with its answer. */
    begin: () => (pending ? -1 : picks),
    serverSaid(order: BotListOrder | undefined, since = picks) {
      if (!order || pending || since !== picks) return;
      if (server === order && chosen === null) return;
      server = order;
      chosen = null;
      emit();
    },
    choose(order: BotListOrder, failed: () => void) {
      const current = chosen ?? server;
      if (!current || order === current) return;
      const pickedIn = session;
      picks += 1;
      pending = true;
      queue("botListOrder", order, current, {
        send: (value) =>
          pickedIn === session ? save(resolveBotListOrder(value)) : Promise.resolve(),
        apply: (value) => {
          if (pickedIn !== session) return;
          chosen = resolveBotListOrder(value);
          emit();
        },
        settled: (failure) => {
          if (pickedIn !== session) return;
          pending = false;
          if (failure) failed();
        },
      });
    },
    /** Another account: forget the order and drop saves still queued. */
    reset() {
      session += 1;
      queue = createSnoozeQueue();
      server = undefined;
      chosen = null;
      pending = false;
      emit();
    },
  };
}
