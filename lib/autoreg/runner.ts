import { randomUUID } from "node:crypto"
import { db } from "@/lib/db"
import { igAutoregAccounts, igAutoregLogs, igAutoregJobs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { registerViaPython, type PyAutoregConfig, type PyAutoregResult } from "@/lib/instagram/py-bridge"

export type RegMethod = "email" | "sms"

export interface AutoregJobConfig {
  method: RegMethod
  threads: number
  targetCount: number
  proxies: string[]            // List of proxy URLs, distributed round-robin
  anymessageApiKey?: string    // For email method
  anymessageDomain?: string    // gmail | icloud | outlook
  textverifiedToken?: string   // For SMS method
  groupLabel?: string          // Optional batch label
}

interface RunningJob {
  jobId: string
  cancel: () => void
}

// Only one job at a time
let currentJob: RunningJob | null = null

/** Start a new autoreg job. Returns the jobId. */
export async function startAutoregJob(config: AutoregJobConfig): Promise<string> {
  if (currentJob) {
    throw new Error("A registration job is already running")
  }

  const jobId = randomUUID()

  // Insert job record
  await db.insert(igAutoregJobs).values({
    jobId,
    status: "running",
    method: config.method,
    threads: config.threads,
    targetCount: config.targetCount,
    config: {
      proxies: config.proxies,
      groupLabel: config.groupLabel || "",
    },
  })

  let cancelled = false
  const cancelFn = () => { cancelled = true }
  currentJob = { jobId, cancel: cancelFn }

  // Run in background (fire and forget)
  runJob(jobId, config, () => cancelled).catch(console.error).finally(() => {
    if (currentJob?.jobId === jobId) currentJob = null
  })

  return jobId
}

/** Cancel the currently running job. */
export async function cancelAutoregJob(jobId: string): Promise<void> {
  if (currentJob?.jobId === jobId) {
    currentJob.cancel()
  }
  await db
    .update(igAutoregJobs)
    .set({ cancelRequested: true })
    .where(eq(igAutoregJobs.jobId, jobId))
}

// ── Job orchestration ────────────────────────────────────────────────────

async function runJob(
  jobId: string,
  config: AutoregJobConfig,
  isCancelled: () => boolean,
) {
  let completed = 0
  let failed = 0
  const total = config.targetCount

  try {
    // Run in batches of `threads` concurrent registrations
    let remaining = total
    let proxyIdx = 0

    while (remaining > 0 && !isCancelled()) {
      // Check if cancel was requested in DB
      const [job] = await db
        .select({ cancelRequested: igAutoregJobs.cancelRequested })
        .from(igAutoregJobs)
        .where(eq(igAutoregJobs.jobId, jobId))
        .limit(1)
      if (job?.cancelRequested) break

      const batchSize = Math.min(config.threads, remaining)
      const promises: Promise<void>[] = []

      for (let i = 0; i < batchSize; i++) {
        if (isCancelled()) break
        const threadIdx = completed + failed + i
        const proxy = config.proxies[proxyIdx % config.proxies.length]
        proxyIdx++

        if (i > 0) {
          const stagger = 1500 + Math.random() * 3000
          const chunk = 200
          let waited = 0
          while (waited < stagger && !isCancelled()) {
            await new Promise((r) => setTimeout(r, Math.min(chunk, stagger - waited)))
            waited += chunk
          }
          if (isCancelled()) break
        }

        promises.push(
          runSingleRegistration(
            jobId,
            threadIdx,
            {
              method: config.method,
              proxy,
              anymessageApiKey: config.anymessageApiKey,
              anymessageDomain: config.anymessageDomain,
              textverifiedApiKey: config.textverifiedToken,
            },
            config.groupLabel || "",
            isCancelled,
          ).then((success) => {
            if (success) completed++
            else failed++
            // Update job counters
            db.update(igAutoregJobs)
              .set({ completed, failed })
              .where(eq(igAutoregJobs.jobId, jobId))
              .catch(console.error)
          }),
        )
      }

      await Promise.allSettled(promises)
      remaining = total - completed - failed
    }

    // Mark job as done
    const finalStatus = isCancelled() || (await checkCancelRequested(jobId))
      ? "cancelled"
      : "done"
    await db
      .update(igAutoregJobs)
      .set({
        status: finalStatus,
        completed,
        failed,
        finishedAt: new Date(),
      })
      .where(eq(igAutoregJobs.jobId, jobId))
  } catch (err) {
    await db
      .update(igAutoregJobs)
      .set({
        status: "error",
        completed,
        failed,
        error: (err as Error).message,
        finishedAt: new Date(),
      })
      .where(eq(igAutoregJobs.jobId, jobId))
  }
}

async function checkCancelRequested(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ cancelRequested: igAutoregJobs.cancelRequested })
    .from(igAutoregJobs)
    .where(eq(igAutoregJobs.jobId, jobId))
    .limit(1)
  return job?.cancelRequested ?? false
}

// ── Single registration via Python backend ──────────────────────────────

async function runSingleRegistration(
  jobId: string,
  threadIndex: number,
  pyConfig: PyAutoregConfig,
  groupLabel: string,
  isCancelled: () => boolean,
): Promise<boolean> {
  // Create log entry
  const [logRow] = await db
    .insert(igAutoregLogs)
    .values({
      jobId,
      threadIndex,
      proxy: pyConfig.proxy,
      method: pyConfig.method,
      step: "init",
      status: "running",
    })
    .returning({ id: igAutoregLogs.id })

  const logId = logRow.id

  // Check cancellation before starting
  if (isCancelled()) {
    await db
      .update(igAutoregLogs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(igAutoregLogs.id, logId))
    return false
  }

  try {
    await db
      .update(igAutoregLogs)
      .set({ step: "registering", stepDetail: "calling python service" })
      .where(eq(igAutoregLogs.id, logId))

    const result = await registerViaPython(pyConfig)

    // Update log with the last step from the Python service
    if (result.steps?.length) {
      const lastStep = result.steps[result.steps.length - 1]
      await db
        .update(igAutoregLogs)
        .set({ step: lastStep.step, stepDetail: lastStep.detail || "" })
        .where(eq(igAutoregLogs.id, logId))
        .catch(console.error)
    }

    if (result.success) {
      // Save to autoreg accounts table
      const [account] = await db
        .insert(igAutoregAccounts)
        .values({
          username: result.username,
          password: result.password,
          email: result.email,
          phone: result.phone,
          igUserId: result.dsUserId,
          bearerToken: result.bearer,
          mid: result.mid,
          claim: result.claim,
          dsUserId: result.dsUserId,
          csrf: result.csrf,
          rur: result.rur,
          deviceId: result.deviceId,
          familyDeviceId: result.familyDeviceId,
          phoneId: result.phoneId,
          pigeonSession: result.pigeonSession,
          fbAnonId: result.fbAnonId,
          waterfallId: result.waterfallId,
          machineId: result.machineId,
          cloudTrustToken: result.cloudTrustToken,
          aacJid: result.aacJid,
          aacCs: result.aacCs,
          iphoneModel: result.iphoneModel,
          iosVersion: result.iosVersion,
          appVersion: result.appVersion,
          locale: result.locale,
          timezone: result.timezone,
          userAgent: result.userAgent,
          sessionBlob: result.sessionBlob,
          proxyUrl: pyConfig.proxy,
          regMethod: pyConfig.method,
          groupLabel,
          status: "created",
        })
        .returning({ id: igAutoregAccounts.id })

      // Update log with success
      await db
        .update(igAutoregLogs)
        .set({
          username: result.username,
          email: result.email,
          phone: result.phone,
          status: "success",
          autoregAccountId: account.id,
          finishedAt: new Date(),
        })
        .where(eq(igAutoregLogs.id, logId))

      return true
    } else {
      // Update log with error
      await db
        .update(igAutoregLogs)
        .set({
          username: result.username,
          email: result.email,
          phone: result.phone,
          status: "error",
          error: result.error || "Registration failed",
          finishedAt: new Date(),
        })
        .where(eq(igAutoregLogs.id, logId))

      return false
    }
  } catch (err) {
    const msg = (err as Error).message
    await db
      .update(igAutoregLogs)
      .set({
        status: "error",
        error: msg,
        finishedAt: new Date(),
      })
      .where(eq(igAutoregLogs.id, logId))

    return false
  }
}
