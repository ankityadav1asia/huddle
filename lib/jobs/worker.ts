// The background worker. Locally it runs on an interval in the server process; on serverless hosting, long-poll
// requests call pump() while they wait. Each pump advances the match feeds, runs housekeeping, then runs due jobs
// with bounded concurrency. Chat delivery never goes through this queue, so a slow AI job cannot block chat.
import { config } from '../config.ts';
import { one, type Db } from '../db/index.ts';
import type { RoomRow } from '../db/rows.ts';
import { log } from '../log.ts';
import { claimJobs, completeJob, failJob, cancelJob, failureTags, type ClaimedJob } from './queue.ts';
import { advanceFeeds } from '../match/feed.ts';
import { handleAnswerJob, handleContinuityJob, handleDebatePollJob, handleMomentumJob } from '../cohost/index.ts';
import { closePoll } from '../chat/polls.ts';
import { endRoom, purgeRoom } from '../rooms/lifecycle.ts';
import { RoomEndedError } from '../rooms/events.ts';
import { sweep } from './sweep.ts';
import { observe, count } from '../metrics.ts';

// Runs one claimed job and names the outcome (for logs and metrics). Handlers are idempotent: a job can run twice.
// Each handler declares only the job fields it reads (payloads hold ids), so tests can call one directly.
type JobHandler = (db: Db, job: ClaimedJob) => Promise<string>;

export const HANDLERS = {
  ai_answer: handleAnswerJob,
  continuity_check: handleContinuityJob,
  debate_poll: handleDebatePollJob,
  momentum_signal: handleMomentumJob,
  poll_close: async (db: Db, job: { payload: { poll_id: string } }) => ((await closePoll(db, job.payload.poll_id)) ? 'closed' : 'done'),
  room_auto_end: async (db: Db, job: { payload: { room_id: string; match_id?: string } }) => {
    // Only for the game the room still follows: migration 013 moved rooms off their own runs onto the shared game.
    const room = job.payload.match_id ? await one<Pick<RoomRow, 'match_id'>>(db, 'SELECT match_id FROM rooms WHERE id = $1', [job.payload.room_id]) : null;
    if (room && room.match_id !== job.payload.match_id) return 'done';
    return (await endRoom(db, job.payload.room_id, { reason: 'match_completed' })) ? 'ended' : 'done';
  },
  room_purge: async (db: Db, job: { payload: { room_id: string } }) => purgeRoom(db, job.payload.room_id),
};

// Job types are read back from the database, so a lookup can find nothing.
const BY_TYPE: Record<string, JobHandler | undefined> = HANDLERS;

let inFlight: Promise<number> | null = null;
let lastSweep = 0;

async function runJob(db: Db, job: ClaimedJob): Promise<string> {
  const started = Date.now();
  let outcome: string;
  try {
    if (job.expires_at && new Date(job.expires_at) <= new Date()) {
      await cancelJob(db, job, 'expired');
      outcome = 'expired';
    } else {
      const handler = Object.hasOwn(BY_TYPE, job.type) ? BY_TYPE[job.type] : undefined; // never Object.prototype names
      if (!handler) throw Object.assign(new Error(`no handler for ${job.type}`), { category: 'unknown_job', retryable: false });
      outcome = await handler(db, job);
      await completeJob(db, job);
    }
  } catch (err) {
    if (err instanceof RoomEndedError) {
      await cancelJob(db, job, 'room_ended');
      outcome = 'room_ended';
    } else {
      outcome = await failJob(db, job, err);
      const tags = failureTags(err);
      log.warn('job.failed', { type: job.type, id: job.id, attempts: job.attempts, outcome, category: tags.category || tags.code, err });
    }
  }
  const ms = Date.now() - started;
  const queueAgeMs = Math.round((job.queue_age_s || 0) * 1000);
  observe('job_ms', ms);
  observe('job_queue_age_ms', queueAgeMs);
  count(`job:${job.type}:${outcome}`);
  log.info('job', { type: job.type, outcome, attempts: job.attempts, queue_age_ms: queueAgeMs, ms });
  return outcome;
}

// Single-flight per process: overlapping callers share one pump.
export function pump(db: Db, { budgetMs = 4000, maxJobs = 8 } = {}): Promise<number> {
  inFlight ||= (async () => {
    try {
      const deadline = Date.now() + budgetMs;
      await advanceFeeds(db);
      if (Date.now() - lastSweep > 60000) {
        lastSweep = Date.now();
        await sweep(db);
      }
      let ran = 0;
      while (ran < maxJobs && Date.now() < deadline) {
        const jobs = await claimJobs(db, { limit: Math.min(config().ai.maxConcurrency, maxJobs - ran) });
        if (!jobs.length) break;
        await Promise.all(jobs.map((j) => runJob(db, j)));
        ran += jobs.length;
      }
      return ran;
    } catch (err) {
      log.error('worker.pump_failed', { err });
      return 0;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startWorker(db: Db): () => void {
  const { intervalMs } = config().worker;
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    await pump(db, { budgetMs: 4000 });
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  let timer = setTimeout(loop, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
