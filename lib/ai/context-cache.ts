// Short-lived, room-scoped cache for derived AI context (never shared across rooms). Keys always start
// with the room id, and closing a room clears its entries.
const store = new Map();

export function cached(roomId, key, ttlMs, compute) {
  const k = `room:${roomId}:${key}`;
  const hit = store.get(k);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = compute();
  store.set(k, { value, expires: Date.now() + ttlMs });
  if (store.size > 500) for (const [key2, v] of store) if (v.expires <= Date.now()) store.delete(key2);
  return value;
}

export function clearRoomContext(roomId) {
  const prefix = `room:${roomId}:`;
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
