/**
 * Proplync.mx · Runway client (listing photo → short motion clip)
 * -----------------------------------------------------------------------------
 * What this is for: the Reel format already writes a script (hook, scenes,
 * CTA) and generate.html renders it as text over ONE still photo. Runway turns
 * the stills into moving footage, so the Reel stops looking like a slideshow.
 *
 * The one rule that shapes this whole file: WE NEVER GENERATE A PROPERTY.
 * Only `image_to_video`, only from a photo the agency actually uploaded, and
 * the prompt is allowed to describe CAMERA MOVEMENT and nothing else. The
 * reason is the same one behind RISKY_CLAIMS in api/generate.js — the copy
 * checker there exists because the model kept inflating "Alberca" into
 * "alberca propia". A video model given room to invent does that with pixels:
 * it will happily add a pool, open a wall, or furnish an empty room, and that
 * lands in front of a buyer as a picture of a house that does not exist.
 * `text_to_video` is therefore not wrapped here at all, on purpose.
 *
 * Even constrained to camera motion, generation drifts — a push-in through a
 * doorway invents the room behind it. That is why clips are kept SHORT (the
 * further the camera travels, the more the model has to make up) and why
 * nothing here publishes: the agent reviews the clip in the dashboard first.
 *
 * ENV VAR: RUNWAYML_API_SECRET (Developer Portal at dev.runwayml.com).
 * Unset = the whole feature reports itself unavailable instead of throwing,
 * matching how notify.js no-ops without a Resend key.
 * -----------------------------------------------------------------------------
 */

import RunwayML, { TaskFailedError } from '@runwayml/sdk';
import { logDegraded } from './health.js';

/* gen4.5 is the current flagship image-to-video model. Runway renames models
   as they ship versions — their own docs warn not to assume an example's model
   id is still live — so it lives here once, next to the ratio and duration
   constraints the SDK types declare for it. If a generation starts failing with
   an unknown-model error, this is the line to change.
   Constraints (from @runwayml/sdk resources/image-to-video.d.ts, v4.20.0):
     duration: integer 2-10
     ratio:    1280:720 | 720:1280 | 1104:832 | 960:960 | 832:1104 | 1584:672 */
export const CLIP_MODEL = 'gen4.5';

/* 720:1280 is the vertical 9:16 option — the shape Reels/TikTok/Shorts want.
   The canvas renderer composites at 1080x1920 and scales this up; a slight
   upscale of real footage beats a pin-sharp frame in the wrong aspect. */
export const CLIP_RATIO = '720:1280';

/* Runway bills gen4.5 at a flat 12 credits per second of output — measured,
   not assumed: 2s quoted 24 credits, 3s quoted 36, 5s quoted 60. Cost is
   therefore purely a function of how many seconds we ask for, which makes
   asking for seconds nobody watches the single most wasteful thing this
   feature can do.
   
   And it was doing exactly that. A fixed 5s clip under a 3.5s beat is 1.5s of
   paid footage the canvas truncates: a 5-clip Reel generated 25 seconds of
   video for a 15-second Reel, and 40% of the bill was never on screen.
   
   So clip length follows the beat it backs. These three constants MUST stay in
   agreement with the frame budget in generate.html's downloadVideo() — if the
   Reel there stops being 15s with a 2s hook, the clips here pay for the drift. */
export const REEL_SECONDS = 15;
export const HOOK_SECONDS = 2;
export const CTA_SECONDS = 3;   /* canvas budgets 2.5s; the API needs an integer */

/* gen4.5 accepts an integer 2-10 seconds. */
const MIN_CLIP = 2;
const MAX_CLIP = 10;

/**
 * How many seconds to generate for one beat.
 * Rounded UP to the next whole second: a clip fractionally shorter than its
 * beat would freeze on its last frame, and one extra second costs 12 credits
 * where a visible stutter costs the agency the shot.
 */
export function clipSeconds(slot, sceneCount) {
  if (slot === 'hook') return HOOK_SECONDS;
  if (slot === 'cta') return CTA_SECONDS;
  const core = (REEL_SECONDS - HOOK_SECONDS - CTA_SECONDS) / Math.max(1, sceneCount);
  return Math.min(MAX_CLIP, Math.max(MIN_CLIP, Math.ceil(core)));
}

/** Credits Runway will charge for a given number of seconds. */
export const CREDITS_PER_SECOND = 12;
export function creditsFor(seconds) { return seconds * CREDITS_PER_SECOND; }

/**
 * The only motions we ask for, keyed by the slot the clip fills in the Reel.
 *
 * Every one of these describes what the CAMERA does and explicitly forbids
 * changing the scene. The trailing clause is not decoration — dropped from an
 * early version, a "slow push-in" on a bedroom photo relit the room and added
 * a window. Say "do not add, remove or alter anything" every single time.
 */
export const CLIP_MOTIONS = {
  hook:  'Slow, steady cinematic push-in toward the center of the frame. The camera moves only; do not add, remove, or alter anything in the scene. No people, no text, no new objects.',
  scene: 'Slow, smooth cinematic pan across the frame with a gentle parallax. The camera moves only; do not add, remove, or alter anything in the scene. No people, no text, no new objects.',
  cta:   'Very slow cinematic pull-back from the frame. The camera moves only; do not add, remove, or alter anything in the scene. No people, no text, no new objects.'
};

/* gen4.5 caps promptText at 1000 UTF-16 code units and rejects an empty one. */
const PROMPT_MAX = 1000;

/** Is the feature configured at all? Callers use this to 503 cleanly. */
export function runwayEnabled() {
  return Boolean(process.env.RUNWAYML_API_SECRET);
}

/* The SDK reads RUNWAYML_API_SECRET from the environment itself. Built lazily
   so importing this module on a deploy without the key set is harmless. */
let client = null;
function getClient() {
  if (!client) client = new RunwayML();
  return client;
}

/**
 * Current credit balance, or null if Runway cannot be reached.
 *
 * Null means "unknown", never "zero" — the caller must not block a job on a
 * failed read, because a brief outage here would refuse Reels the account can
 * perfectly well afford.
 */
export async function creditBalance() {
  try {
    const org = await getClient().organization.retrieve();
    return typeof org?.creditBalance === 'number' ? org.creditBalance : null;
  } catch (err) {
    logDegraded('runway:organization.retrieve', err);
    return null;
  }
}

/** Resolve the camera-motion prompt for a Reel slot, clamped to the API cap. */
export function motionPrompt(slot) {
  return (CLIP_MOTIONS[slot] || CLIP_MOTIONS.scene).slice(0, PROMPT_MAX);
}

/**
 * Submit one clip and return immediately with its task id.
 *
 * Deliberately does NOT call .waitForTaskOutput(). A measured gen4.5 clip took
 * 104 seconds, and this account renders them ONE AT A TIME (gen4.5 reports
 * maxConcurrentGenerations: 1), so a full Reel is 5-9 minutes of wall time.
 * Hobby functions allow up to 300s, which is enough for one clip but not for a
 * Reel — and a function billed for nine minutes of waiting on I/O is the wrong
 * shape regardless. So the task id goes to the database and the browser polls
 * via action=reel-status.
 *
 * @param {string} imageUrl  public HTTPS URL of a real listing photo
 * @param {string} slot      'hook' | 'scene' | 'cta'
 * @param {number} seconds   integer 2-10, from clipSeconds()
 * @returns {Promise<{taskId: string, estimatedCredits: number|null}>}
 */
export async function startClip(imageUrl, slot, seconds) {
  const task = await getClient().imageToVideo.create({
    model: CLIP_MODEL,
    promptImage: imageUrl,
    promptText: motionPrompt(slot),
    ratio: CLIP_RATIO,
    duration: seconds
  });
  return {
    taskId: task.id,
    // Present on the create response and on PENDING reads; lets us show an
    // agency what a Reel cost before we have a final number.
    estimatedCredits: task?.estimatedCost?.credits ?? null
  };
}

/**
 * Read one task's state, normalised to what the poller cares about.
 *
 * Runway reports six statuses — PENDING, THROTTLED, RUNNING, CANCELLED,
 * FAILED, SUCCEEDED — not the three its API summary lists. THROTTLED is the
 * one worth knowing about: it means queued behind account concurrency limits,
 * which is still "keep waiting", not an error.
 *
 * @returns {Promise<{state:'working'|'done'|'failed', url?:string, credits?:number, error?:string}>}
 */
export async function readClip(taskId) {
  let task;
  try {
    task = await getClient().tasks.retrieve(taskId);
  } catch (err) {
    // TaskFailedError carries the real reason (usually content moderation)
    // where a generic catch would only ever show "request failed".
    if (err instanceof TaskFailedError) {
      logDegraded('runway:task-failed', err.taskDetails);
      return { state: 'failed', error: 'generation_failed' };
    }
    logDegraded('runway:tasks.retrieve', err);
    return { state: 'failed', error: 'runway_unreachable' };
  }

  if (task.status === 'SUCCEEDED') {
    const url = Array.isArray(task.output) ? task.output[0] : null;
    if (!url) return { state: 'failed', error: 'no_output' };
    // These URLs expire in 24-48h and Runway's own types say to download and
    // store them yourself. api/reel.js does exactly that before returning.
    return { state: 'done', url, credits: task?.cost?.credits ?? null };
  }

  if (task.status === 'FAILED' || task.status === 'CANCELLED') {
    logDegraded('runway:task-terminal', `${taskId} -> ${task.status}`);
    return { state: 'failed', error: task.status.toLowerCase() };
  }

  return { state: 'working' };
}
