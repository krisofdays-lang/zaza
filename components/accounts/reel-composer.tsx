"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { getMediaForPicker, type PickerMedia } from "@/app/actions/storage"
import { publishNow } from "@/app/actions/publications"
import type { DisplayAccount } from "@/app/actions/accounts"
import { X, Loader2, Check, Film, ImageOff } from "lucide-react"

/**
 * Instagram-style "new reel" composer rendered inside the phone frame.
 * Picks a video from the media library and publishes it through the full
 * upload_settings -> rupload_igvideo -> configure_to_clips flow (runPublication).
 */
export function ReelComposer({
  account,
  open,
  onClose,
}: {
  account: DisplayAccount
  open: boolean
  onClose: () => void
}) {
  const [media, setMedia] = useState<PickerMedia[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [caption, setCaption] = useState("")
  const [step, setStep] = useState<"pick" | "details">("pick")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    getMediaForPicker().then((rows) => {
      setMedia(rows)
      setLoaded(true)
    })
  }, [open])

  // Reset transient state whenever the sheet is reopened.
  useEffect(() => {
    if (open) {
      setSelectedId(null)
      setCaption("")
      setStep("pick")
    }
  }, [open])

  const videos = useMemo(() => media.filter((m) => m.kind === "video"), [media])
  const selected = useMemo(() => videos.find((v) => v.id === selectedId) ?? null, [videos, selectedId])

  if (!open) return null

  function share() {
    if (!selected) return
    startTransition(async () => {
      try {
        const res = await publishNow({
          type: "reel",
          caption,
          accountIds: [account.id],
          assignments: [{ accountId: account.id, mediaIds: [selected.id], caption }],
        })
        const outcome = res.results[0]
        if (res.ok) {
          toast.success("Reel shared", { description: outcome?.message })
          onClose()
        } else {
          toast.error("Couldn't share reel", { description: outcome?.message ?? res.error })
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to publish reel")
      }
    })
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white font-sans text-[#000000]">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[#dbdbdb] px-3 py-2.5">
        <button
          aria-label={step === "details" ? "Back" : "Close"}
          onClick={() => (step === "details" ? setStep("pick") : onClose())}
          disabled={pending}
          className="flex size-8 items-center justify-center"
        >
          <X className="size-6" strokeWidth={2} />
        </button>
        <span className="text-[16px] font-semibold">{step === "details" ? "New reel" : "Select a reel"}</span>
        {step === "pick" ? (
          <button
            onClick={() => setStep("details")}
            disabled={!selected}
            className={`text-[15px] font-semibold ${selected ? "text-[#0095f6]" : "text-[#b2dffc]"}`}
          >
            Next
          </button>
        ) : (
          <button
            onClick={share}
            disabled={pending}
            className="flex items-center gap-1 text-[15px] font-semibold text-[#0095f6] disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Share
          </button>
        )}
      </header>

      {step === "pick" ? (
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {!loaded ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-[#8e8e8e]" />
            </div>
          ) : videos.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[#737373]">
              <Film className="size-10" strokeWidth={1.2} />
              <p className="text-[14px]">No videos in your library yet.</p>
              <p className="text-[12px]">Upload a video in Storage, then come back to share it as a reel.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-0.5 p-0.5">
              {videos.map((v) => {
                const active = v.id === selectedId
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedId(v.id)}
                    className="relative aspect-[9/16] overflow-hidden bg-black"
                  >
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      src={v.blobUrl}
                      muted
                      playsInline
                      preload="metadata"
                      className="size-full object-cover"
                    />
                    <Film className="absolute right-1.5 top-1.5 size-4 text-white drop-shadow" />
                    {active && (
                      <span className="absolute inset-0 flex items-center justify-center bg-[#0095f6]/35">
                        <span className="flex size-7 items-center justify-center rounded-full bg-[#0095f6] ring-2 ring-white">
                          <Check className="size-4 text-white" strokeWidth={3} />
                        </span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-3">
            <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-md bg-black">
              {selected ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video src={selected.blobUrl} muted playsInline preload="metadata" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <ImageOff className="size-6 text-[#8e8e8e]" />
                </div>
              )}
            </div>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write a caption..."
              rows={6}
              className="min-h-[120px] flex-1 resize-none bg-transparent text-[14px] leading-[19px] outline-none placeholder:text-[#8e8e8e]"
            />
          </div>

          <div className="mt-2 border-t border-[#dbdbdb] pt-3 text-[13px] text-[#737373]">
            Posting to <span className="font-semibold text-[#262626]">@{account.username || account.label}</span> via the
            full reel flow (upload settings, video upload, configure).
          </div>
        </div>
      )}
    </div>
  )
}
