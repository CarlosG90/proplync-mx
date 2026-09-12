/**
 * Proplync.mx · Runway Reel jobs (start + poll)
 * -----------------------------------------------------------------------------
 * Lives in _lib and is routed from api/generate.js rather than being its own
 * api/reel.js, for the reason already written twice in this codebase: Vercel
 * Hobby caps a project at 12 serverless functions and we are at 11. Files under
 * _lib are imported, not deployed as functions, so this costs nothing from that
 * budget while keeping the logic out of generate.js's already-long body.
 *
 * The shape of this file is dictated by one hard constraint: a full Reel takes
 * 5-9 minutes (clips render sequentially — see runway.js) while this function
 * is capped at 60s in vercel.json, against a Hobby ceiling of 300s. No single
 * request can cover it. So the work is split across two that share state
 * through the reel_jobs table —
 *
 *   start  → submit N clips to Runway, write the task ids down, return a job id
 *   status → read each task, move finished clips into our own storage, report
 *
 * The browser polls `status` until the job leaves 'working'. Nothing here ever
 * blocks on a generation, and nothing here publishes: the agent reviews the
 * finished Reel in the dashboard before it goes anywhere.
 * -----------------------------------------------------------------------------
 */

import { getServiceClient } from './supabase.js';
import { reelAccess } from './plans.js';
import { runwayEnabled, startClip, readClip, clipSeconds, creditsFor, creditBalance } from './runway.js';
import { safeDetail, logDegraded } from './health.js';

const BUCKET = 'reel-clips';

/* A Reel is hook + up to 3 scenes + CTA. Capped at 5 because every clip is a
   separate billed generation, and the canvas renderer only budgets ~15s. */
const MAX_CLIPS = 5;

/* How many finished clips one status request will copy into storage.
   Each copy is a download from Runway plus an upload to Supabase, and four of
   them landing in the same 30s request is how you turn a working feature into
   a timeout. The browser is polling anyway, so the rest arrive next tick. */
const COPIES_PER_POLL = 2;

/** First day of the current month, as the quota window. */
function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Decide which real photo backs each beat of the Reel.
 *
 * Always the agency's own uploaded photos, never a generated frame — see the
 * header of _lib/runway.js for why that rule is absolute. Photos are reused
 * when a listing has fewer images than beats: showing the same room twice is
 * honest, and inventing a second room is not.
 */
function planClips(photos, sceneCount) {
  const slots = [
    { slot: 'hook' },
    ...Array.from({ length: Math.max(0, sceneCount) }, () => ({ slot: 'scene' })),
    { slot: 'cta' }
  ].slice(0, MAX_CLIPS);

  return slots.map((s, i) => ({
    ...s,
    // Hook gets the cover shot, the CTA returns to it (a Reel that ends where
    // it started reads as deliberate), scenes walk through the rest.
    source_photo: s.slot === 'cta' ? photos[0] : photos[i % photos.length],
    // Generated seconds match the beat this clip backs. See runway.js: Runway
    // bills per second, so a clip longer than its beat is footage the canvas
    // truncates and the agency still pays for.
    seconds: clipSeconds(s.slot, sceneCount)
  }));
}

/* ── START ──────────────────────────────────────────────────────────────── */

export async function startReel(req, res, auth) {
  if (!runwayEnabled()) {
    res.status(503).json({ error: 'reels_unavailable', detail: 'RUNWAYML_API_SECRET is not set' });
    return;
  }

  const listingId = String((req.body && req.body.listing_public_id) || '').trim();
  if (!listingId) {
    res.status(400).json({ error: 'missing_listing' });
    return;
  }
  const sceneCount = Math.min(3, Math.max(1, Number((req.body && req.body.scenes) || 3)));

  const svc = getServiceClient();

  /* Listing lookup is scoped to the caller's agency, so a valid token for one
     agency cannot start a Reel against another agency's listing. */
  const { data: listing, error: listingErr } = await svc
    .from('listings')
    .select('public_id, image, images')
    .eq('public_id', listingId)
    .eq('agency_id', auth.agencyId)
    .single();

  if (listingErr || !listing) {
    res.status(404).json({ error: 'listing_not_found' });
    return;
  }

  /* Runway needs a public HTTPS URL it can fetch. listing-photos is a public
     bucket so the stored URLs qualify; anything else (a data URI, a blob) does
     not, and would fail inside Runway with a far less obvious message. */
  const photos = [listing.image, ...(listing.images || [])]
    .filter(u => typeof u === 'string' && /^https:\/\//i.test(u));

  if (!photos.length) {
    res.status(422).json({
      error: 'no_usable_photos',
      detail: 'This listing has no public HTTPS photo to animate. Upload a photo first.'
    });
    return;
  }

  /* ── Quota ──
     Checked against the agency row and a live count of this month's jobs,
     never against anything the browser sent. */
  const { data: agency } = await svc
    .from('agencies').select('id, plan, marketing_trials_used').eq('id', auth.agencyId).single();

  const { count, error: countErr } = await svc
    .from('reel_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('agency_id', auth.agencyId)
    .gte('created_at', monthStart());

  /* `count` is null, with NO error, when the table is missing — PostgREST
     answers a head-count against an absent relation without complaining. The
     first version of this read that null as `count || 0`, decided the agency
     had used zero of their quota, and cheerfully submitted a full Reel to
     Runway before the insert below failed. That mistake is billable: it cost
     204 credits to discover.

     So an unknown count is a REFUSAL, not a zero. For a resource that charges
     per call, "I could not verify the quota" and "the quota is free" must
     never be the same branch. */
  if (countErr || typeof count !== 'number') {
    logDegraded('supabase:reel_jobs.count', countErr || 'count came back null (is 006_reel_clips.sql applied?)');
    res.status(503).json({ error: 'quota_check_failed' });
    return;
  }

  const access = reelAccess(agency, count);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason, limit: access.limit, used: count || 0 });
    return;
  }

  const planned = planClips(photos, sceneCount);
  const plannedCredits = creditsFor(planned.reduce((n, c) => n + c.seconds, 0));

  /* ── Credit preflight ──
     Runway rejects a generation once the balance runs out, and without this
     check that rejection arrives clip by clip: the agency spends their whole
     remaining balance on the first two beats, burns a monthly quota slot, and
     gets back half a Reel. Checking the balance first turns that into a clean
     "you need N more credits" before anything is charged.

     A failed balance read is NOT treated as a failure — Runway being briefly
     unreachable should not block a job that would have been affordable. The
     per-clip failure path below still catches a genuine out-of-credits.

     This runs BEFORE the row is reserved, and the order is load-bearing: it
     was the other way around first, and a refused Reel still wrote a row that
     sat at 'working' forever, silently eating one of the agency's monthly
     quota slots for a Reel that never existed. A pure balance read costs
     nothing, so refusing before writing is strictly better. */
  const balance = await creditBalance();
  if (balance !== null && balance < plannedCredits) {
    res.status(402).json({
      error: 'insufficient_credits',
      needed: plannedCredits,
      balance,
      detail: `This Reel needs ${plannedCredits} Runway credits and the account has ${balance}.`
    });
    return;
  }

  /* ── Reserve the job row BEFORE spending a credit ──
     Ordering matters more than it looks. Submitting first and recording second
     means any database failure lands AFTER Runway has been paid: the clips
     render, nothing points at them, and the agency is billed for a Reel that
     does not exist. That is not hypothetical — it is exactly what happened
     while building this, to the tune of 204 credits.

     Writing the row first inverts the failure: if the database is unavailable
     the agency gets a clean error and owes nothing, and the only cost of the
     reverse failure (row written, submit fails) is a row marked failed. */
  const { data: job, error: insertErr } = await svc
    .from('reel_jobs')
    .insert({
      agency_id: auth.agencyId,
      listing_public_id: listing.public_id,
      status: 'working',
      clips: planned.map(c => ({ ...c, task_id: null, state: 'pending' }))
    })
    .select('id')
    .single();

  if (insertErr || !job) {
    logDegraded('supabase:reel_jobs.insert', insertErr || 'no row returned');
    res.status(503).json({ error: 'job_not_saved', detail: 'Could not start the Reel. Nothing was charged.' });
    return;
  }

  /* ── Submit ──
     Clips go up in parallel, but note gen4.5 allows only ONE concurrent
     generation on this account: Runway accepts all of them and runs them in
     sequence, reporting the waiting ones as THROTTLED (which readClip treats
     as 'working'). Submitting together is still right — it queues them in one
     round-trip and the queue drains without further prompting — but it means
     a Reel takes roughly the SUM of its clips' render times, not the longest.
     Measured: a 5s clip took 104s, so a full Reel lands in 5-9 minutes.

     A clip Runway refuses at submit time is recorded as failed rather than
     sinking the whole job: a Reel with three of four clips still renders,
     because the canvas falls back to the still photo for the missing beat. */
  const clips = await Promise.all(planned.map(async (c) => {
    try {
      const { taskId, estimatedCredits } = await startClip(c.source_photo, c.slot, c.seconds);
      return { ...c, task_id: taskId, state: 'working', estimated_credits: estimatedCredits };
    } catch (err) {
      // safeDetail() logs internally, so no separate logDegraded here.
      return { ...c, task_id: null, state: 'failed', error: safeDetail(err, 'runway:imageToVideo.create') };
    }
  }));

  if (clips.every(c => c.state === 'failed')) {
    // Close the reserved row out rather than leaving it 'working' forever,
    // where it would count against the agency's monthly quota unused.
    await svc.from('reel_jobs')
      .update({ status: 'failed', clips, error: 'runway_rejected_all_clips', updated_at: new Date().toISOString() })
      .eq('id', job.id);
    res.status(502).json({ error: 'runway_rejected_all_clips' });
    return;
  }

  /* Record the task ids against the row we already reserved. If THIS write
     fails the clips are genuinely orphaned, so it says so plainly rather than
     reporting a clean failure the agency would simply retry (and pay for
     twice). */
  const { error: updateErr } = await svc
    .from('reel_jobs')
    .update({ clips, updated_at: new Date().toISOString() })
    .eq('id', job.id);

  if (updateErr) {
    logDegraded('supabase:reel_jobs.attachTasks', updateErr);
    res.status(500).json({
      error: 'tasks_not_recorded',
      job_id: job.id,
      detail: 'Clips were submitted and billed, but their ids could not be saved. Do not retry — contact support.'
    });
    return;
  }

  res.status(202).json({
    job_id: job.id,
    status: 'working',
    clips: clips.map(({ slot, state, seconds }) => ({ slot, state, seconds })),
    estimated_credits: plannedCredits,
    reels_left: access.left - 1
  });
}

/* ── STATUS ─────────────────────────────────────────────────────────────── */

/**
 * Copy one finished clip out of Runway and into our bucket.
 * Runway's URLs die in 24-48h; theirs is a handoff, not a home.
 *
 * Exported so a smoke test can exercise the real copy path rather than a
 * reimplementation of it — this is the step most likely to break in a new
 * environment (bucket missing, credentials wrong, asset URL already expired).
 */
export async function persistClip(svc, jobId, clip, runwayUrl) {
  const path = `${jobId}/${clip.slot}-${clip.task_id}.mp4`;
  const resp = await fetch(runwayUrl);
  if (!resp.ok) throw new Error(`runway asset fetch ${resp.status}`);
  const body = Buffer.from(await resp.arrayBuffer());

  const { error } = await svc.storage.from(BUCKET).upload(path, body, {
    contentType: 'video/mp4',
    upsert: true
  });
  if (error) throw error;

  const { data } = svc.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function reelStatus(req, res, auth) {
  const jobId = String((req.query && req.query.job) || (req.body && req.body.job_id) || '').trim();
  if (!jobId) {
    res.status(400).json({ error: 'missing_job' });
    return;
  }

  const svc = getServiceClient();
  const { data: job, error } = await svc
    .from('reel_jobs')
    .select('id, status, clips, credits_spent, listing_public_id')
    .eq('id', jobId)
    .eq('agency_id', auth.agencyId)   // scoping, again: a job id is not a capability
    .single();

  if (error || !job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }

  if (job.status !== 'working') {
    res.status(200).json(publicJob(job));
    return;
  }

  const clips = [...job.clips];
  let credits = Number(job.credits_spent || 0);
  let copied = 0;
  let changed = false;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (clip.state !== 'working' || !clip.task_id) continue;

    const result = await readClip(clip.task_id);

    if (result.state === 'working') continue;

    if (result.state === 'failed') {
      clips[i] = { ...clip, state: 'failed', error: result.error };
      changed = true;
      continue;
    }

    // Done. Budget how many we move per request — see COPIES_PER_POLL.
    if (copied >= COPIES_PER_POLL) continue;
    try {
      const stored = await persistClip(svc, job.id, clip, result.url);
      clips[i] = { ...clip, state: 'done', video_path: stored.path, video_url: stored.url };
      credits += Number(result.credits || 0);
      copied++;
      changed = true;
    } catch (err) {
      // The generation succeeded and was billed; only the copy failed. Leave
      // the clip 'working' so the next poll retries — Runway's URL is good for
      // hours, so a transient storage blip costs a retry, not a regeneration.
      logDegraded('reel:persistClip', err);
    }
  }

  const settled = clips.every(c => c.state !== 'working');
  const anyDone = clips.some(c => c.state === 'done');
  const status = settled ? (anyDone ? 'done' : 'failed') : 'working';

  if (changed || status !== job.status) {
    const { error: updateErr } = await svc
      .from('reel_jobs')
      .update({ clips, status, credits_spent: credits, updated_at: new Date().toISOString() })
      .eq('id', job.id);
    if (updateErr) logDegraded('supabase:reel_jobs.update', updateErr);
  }

  res.status(200).json(publicJob({ ...job, clips, status, credits_spent: credits }));
}

/** Only what the browser needs — no task ids, no storage paths. */
function publicJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    listing_public_id: job.listing_public_id,
    credits_spent: Number(job.credits_spent || 0),
    clips: (job.clips || []).map(c => ({
      slot: c.slot,
      state: c.state,
      url: c.video_url || null,
      source_photo: c.source_photo || null
    }))
  };
}
