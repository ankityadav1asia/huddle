// Short-lived, room-scoped cache for derived AI context: never shared across rooms, and cleared when the room closes.
const store = new Map<string, { value: unknown; expires: number }>();

export function cached<T>(roomId: string, key: string, ttlMs: number, compute: () => T): T {
  const k = `room:${roomId}:${key}`;
  const hit = store.get(k);
  if (hit && hit.expires > Date.now()) return hit.value as T; // a key is only ever filled by the same computation
  const value = compute();
  store.set(k, { value, expires: Date.now() + ttlMs });
  if (store.size > 500) for (const [key2, v] of store) if (v.expires <= Date.now()) store.delete(key2);
  return value;
}

export function forget(roomId: string, key: string) {
  store.delete(`room:${roomId}:${key}`);
}

export function clearRoomContext(roomId: string) {
  const prefix = `room:${roomId}:`;
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
