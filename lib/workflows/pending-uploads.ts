// Client-only registry for files chosen via "Upload bunch". These files must
// NOT be uploaded to storage until the workflow actually runs — so instead of
// living in the serialized graph, an assignment only stores a `pendingKey`
// string. The real File plus a preview object URL are kept here, in memory, and
// are resolved (uploaded) right before a run by the workflow editor.
//
// Because it is a module-level map, entries survive switching between Edit Step
// panels within a session. They are intentionally lost on reload — matching the
// rule that bunch-attached media is only persisted to storage on run.

let counter = 0
const registry = new Map<string, { file: File; url: string }>()

// Store a file and return the key to reference it from an assignment.
export function registerPendingFile(file: File): string {
  const key = `pending-${Date.now()}-${counter++}`
  registry.set(key, { file, url: URL.createObjectURL(file) })
  return key
}

export function getPendingFile(key: string): File | undefined {
  return registry.get(key)?.file
}

// A blob: object URL for previewing the file before it is uploaded.
export function getPendingUrl(key: string): string | undefined {
  return registry.get(key)?.url
}

export function revokePendingFile(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  URL.revokeObjectURL(entry.url)
  registry.delete(key)
}

// Whether a graph has any bunch-attached media still waiting to be uploaded.
export function graphHasPendingUploads(graph: unknown): boolean {
  let found = false
  walkPendingHolders(graph, () => {
    found = true
  })
  return found
}

type PendingHolder = {
  pendingKey?: string | null
  mediaId?: number | null
  mediaUrl?: string | null
  mediaName?: string | null
}

// Visit every assignment/item object that can carry a pendingKey inside a graph.
function walkPendingHolders(graph: unknown, visit: (holder: PendingHolder) => void) {
  const g = graph as { nodes?: Array<{ data?: { config?: unknown } }> } | null
  if (!g?.nodes) return
  for (const node of g.nodes) {
    const config = node.data?.config as
      | { assignments?: Array<PendingHolder & { items?: PendingHolder[] }> }
      | undefined
    if (!config?.assignments) continue
    for (const a of config.assignments) {
      if (Array.isArray(a.items)) {
        for (const item of a.items) if (item.pendingKey) visit(item)
      } else if (a.pendingKey) {
        visit(a)
      }
    }
  }
}

// Upload every pending file referenced by the graph to storage, then rewrite the
// holders in place with the returned real mediaId/mediaUrl and drop pendingKey.
// The same file (shared pendingKey across accounts) is uploaded only once.
// Returns the number of files uploaded. Throws if any upload fails so the caller
// can abort the run. `upload` is the uploadMedia server action.
export async function resolvePendingUploads(
  graph: unknown,
  upload: (formData: FormData) => Promise<{ ok: boolean; media?: { id: number; blobUrl: string; name: string; kind: string }; error?: string }>,
): Promise<number> {
  const holders: PendingHolder[] = []
  walkPendingHolders(graph, (h) => holders.push(h))
  if (holders.length === 0) return 0

  const uniqueKeys = [...new Set(holders.map((h) => h.pendingKey).filter((k): k is string => Boolean(k)))]
  const resolved = new Map<string, { id: number; blobUrl: string; name: string; kind: string }>()

  // Upload in parallel batches of 4 to avoid blocking the UI with sequential
  // network round-trips while staying under browser connection limits.
  const BATCH_SIZE = 4
  for (let i = 0; i < uniqueKeys.length; i += BATCH_SIZE) {
    const batch = uniqueKeys.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (key) => {
        const file = getPendingFile(key)
        if (!file) throw new Error("A bunch-attached file is no longer available. Re-attach it and try again.")
        const fd = new FormData()
        fd.set("file", file)
        const res = await upload(fd)
        if (!res.ok || !res.media) throw new Error(res.error ?? "Failed to upload a bunch-attached file")
        return { key, media: res.media }
      }),
    )
    for (const { key, media } of results) {
      resolved.set(key, media)
    }
  }

  for (const h of holders) {
    const media = h.pendingKey ? resolved.get(h.pendingKey) : undefined
    if (!media) continue
    h.mediaId = media.id
    h.mediaUrl = media.blobUrl
    h.mediaName = media.name
    h.pendingKey = null
  }

  for (const key of uniqueKeys) revokePendingFile(key)
  return uniqueKeys.length
}
