// One modest background worker. Locally it runs on an interval inside the server process; on serverless
// hosting, long-poll requests call pump() while they wait. Each pump advances the shared match feeds, runs a
// little housekeeping, then claims and runs due jobs with bounded concurrency. A slow AI job never blocks chat:
// chat delivery does not go through this queue at all.
import { config } from '../config.js';
import { log } from '../log.js';
import { claimJobs, completeJob, failJob, cancelJob } from './queue.js';
import { advanceFeeds } from '../match/feed.js';
import { handleAnswerJob, handleContinuityJob, handleMomentumJob } from '../cohost/index.js';
import { handleInviteJob, handlePushDelivery } from '../notify/index.js';
import { closePoll } from '../chat/polls.js';
import { endRoom, purgeRoom } from '../rooms/lifecycle.js';
import { RoomEndedError } from '../rooms/events.js';
import { sweep } from './sweep.js';
import { observe, count } from '../metrics.js';

export const HANDLERS = {
  ai_answer: handleAnswerJob,
  continuity_check: handleContinuityJob,
  momentum_signal: handleMomentumJob,
  poll_close: async (db, job) => ((await closePoll(db, job.payload.poll_id)) ? 'closed' : 'done'),
  room_auto_end: async (db, job) => ((await endRoom(db, job.payload.room_id, { reason: 'match_completed' })) ? 'ended' : 'done'),
  room_purge: async (db, job) => purgeRoom(db, job.payload.room_id),
  push_invite: handleInviteJob,
  push_delivery: handlePushDelivery,
};

let inFlight = null;
let lastSweep = 0;

export async function runJob(db, job) {
  const started = Date.now();
  let outcome;
  try {
    if (job.expires_at && new Date(job.expires_at) <= new Date()) {
      await cancelJob(db, job, 'expired');
      outcome = 'expired';
    } else {
      const handler = HANDLERS[job.type];
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
      log.warn('job.failed', { type: job.type, id: job.id, attempts: job.attempts, outcome, category: err?.category || err?.code, err });
    }
  }
  const ms = Date.now() - started;
  observe('job_ms', ms);
  observe('job_queue_age_ms', Math.round((job.queue_age_s || 0) * 1000));
  count(`job:${job.type}:${outcome}`);
  log.info('job', { type: job.type, outcome, attempts: job.attempts, queue_age_ms: Math.round((job.queue_age_s || 0) * 1000), ms });
  return outcome;
}

// Single-flight per process: overlapping callers share one pump.
export function pump(db, { budgetMs = 4000, maxJobs = 8 } = {}) {
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

export function startWorker(db) {
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
