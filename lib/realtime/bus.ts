// In-process wake-ups for long-polling clients. On a single local server a commit wakes waiting polls
// immediately; across serverless instances the poll loop also re-checks the database every second.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const notifyRoom = (roomId: string) => bus.emit(`room:${roomId}`);

export function waitForRoom(roomId: string, ms: number) {
  return new Promise<void>((resolve) => {
    const key = `room:${roomId}`;
    const done = () => {
      clearTimeout(timer);
      bus.off(key, done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    bus.on(key, done);
  });
}
