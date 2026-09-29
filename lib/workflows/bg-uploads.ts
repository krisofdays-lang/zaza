// Background upload tracker. Lives at module scope so uploads survive component
// unmount/remount cycles. Panels register uploads here; any component can
// subscribe to status changes and check whether a node has active uploads.

type MediaResult = { id: number; name: string; kind: string; blobUrl: string }
type UploadFn = (fd: FormData) => Promise<{ ok: boolean; media?: MediaResult; error?: string }>

interface UploadJob {
  nodeId: string
  total: number
  done: number
}

const jobs = new Map<string, UploadJob>()
const listeners = new Set<() => void>()
const freshMedia: MediaResult[] = []

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function isNodeUploading(nodeId: string): boolean {
  for (const job of jobs.values()) {
    if (job.nodeId === nodeId && job.done < job.total) return true
  }
  return false
}

export function getNodeUploadProgress(nodeId: string): { done: number; total: number } | null {
  for (const job of jobs.values()) {
    if (job.nodeId === nodeId) return { done: job.done, total: job.total }
  }
  return null
}

export function getFreshMedia(): MediaResult[] {
  return freshMedia
}

export function startBunchUpload(
  nodeId: string,
  files: Array<{ accountId: number; file: File }>,
  uploadFn: UploadFn,
  onComplete: (results: Array<{ accountId: number; media: MediaResult | null }>) => void,
): void {
  const jobId = `${nodeId}-${Date.now()}`
  const job: UploadJob = { nodeId, total: files.length, done: 0 }
  jobs.set(jobId, job)
  notify()

  Promise.all(
    files.map(async ({ accountId, file }) => {
      const fd = new FormData()
      fd.append("file", file)
      try {
        const res = await uploadFn(fd)
        job.done++
        notify()
        if (res.ok && res.media) {
          if (!freshMedia.some((m) => m.id === res.media!.id)) {
            freshMedia.push(res.media)
          }
          return { accountId, media: res.media }
        }
      } catch {
        job.done++
        notify()
      }
      return { accountId, media: null as MediaResult | null }
    }),
  ).then((results) => {
    jobs.delete(jobId)
    notify()
    onComplete(results)
  })
}

export function startSingleUpload(
  nodeId: string,
  accountId: number,
  file: File,
  uploadFn: UploadFn,
  onComplete: (media: MediaResult | null) => void,
): void {
  startBunchUpload(nodeId, [{ accountId, file }], uploadFn, (results) => {
    onComplete(results[0]?.media ?? null)
  })
}
