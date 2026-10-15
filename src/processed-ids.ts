/**
 * Bounded FIFO cache of processed message IDs. Used to dedup inbound_message
 * events that may arrive twice via independent paths:
 *
 *   - Live WS push receives msg N
 *   - WS reconnect / poll triggerBackfill() refetches inbound since the disk
 *     cursor, re-emitting msg N if the cursor lagged behind the live emit
 *   - Two integration sockets briefly subscribed to assistant:<id> during a
 *     disconnect/reconnect race, both delivering the same payload
 *   - Backend transport-level retry
 *
 * Without dedup, the daemon dispatches each duplicate to the Gobot brain and
 * posts the reply again. Ported from openclaw-channel-bgos/src/processed-ids.ts
 * (observed in prod 2026-05-10: chat 917 had four assistant replies for two
 * user questions, including identical-text pairs 1.3s apart). The Set is
 * bounded by `capacity` (FIFO eviction by insertion order) so memory does not
 * grow unbounded for long-running daemons.
 */
export class ProcessedIdsCache {
  private readonly seen: Set<number | string>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.seen = new Set<number | string>();
  }

  /**
   * Returns true if this is the FIRST time we have seen this id (caller
   * should proceed to dispatch). Returns false if it is a duplicate (caller
   * should silently skip).
   *
   * Note: re-marking an already-cached id does NOT promote it. Eviction
   * order is strict insertion order, which is fine for our sliding-window
   * use case: we do not care about LRU semantics, only "did we see this
   * recently."
   *
   * `assistantId` scopes the id to ONE agent. The backend delivers a room or
   * channel message addressed to several agents as one row per agent, all with
   * the SAME message id, so an id alone would drop every agent after the first.
   * Omit it for the legacy id-only behaviour.
   */
  markIfFirstTime(messageId: number, assistantId?: number): boolean {
    const key =
      assistantId === undefined ? messageId : `${assistantId}:${messageId}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    if (this.seen.size > this.capacity) {
      // Set iteration is insertion order in JS: the first value is the
      // oldest entry. Drop it.
      const oldest = this.seen.values().next().value as
        | number
        | string
        | undefined;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}
