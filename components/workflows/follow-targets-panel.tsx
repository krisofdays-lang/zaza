"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { UserPlus, UserMinus, Timer, Hash } from "lucide-react"
import { type FollowTargetsConfig, parseUsernames } from "@/lib/workflows/types"

export function FollowTargetsPanel({
  value,
  onChange,
  mode = "follow",
}: {
  value: FollowTargetsConfig
  onChange: (next: FollowTargetsConfig) => void
  mode?: "follow" | "unfollow"
}) {
  // Keep the raw textarea text local so the user can type freely (spaces,
  // trailing newlines); the parsed list is what we persist to the config.
  const [rawUsernames, setRawUsernames] = useState(value.usernames.join("\n"))

  function patch(partial: Partial<FollowTargetsConfig>) {
    onChange({ ...value, ...partial })
  }

  // Labels switch between the Follow and Unfollow variants; the config shape
  // and divide-the-list claim logic are identical for both.
  const isUnfollow = mode === "unfollow"
  const verb = isUnfollow ? "unfollow" : "follow"
  const Icon = isUnfollow ? UserMinus : UserPlus

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" /> {isUnfollow ? "Unfollow" : "Follow"} behaviour
      </p>

      {/* Actions per account */}
      <div className="space-y-2">
        <Label htmlFor="follows-count" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Hash className="size-3.5" /> {isUnfollow ? "Unfollows" : "Follows"} per account
        </Label>
        <Input
          id="follows-count"
          type="number"
          min={1}
          max={1000}
          value={value.followsPerAccount}
          onChange={(e) => patch({ followsPerAccount: Math.max(1, Math.round(Number(e.target.value) || 0)) })}
        />
        <p className="text-[11px] text-muted-foreground">
          How many accounts each of your accounts will {verb} in this step.
        </p>
      </div>

      {/* Delay between actions */}
      <div className="space-y-2">
        <Label htmlFor="follow-delay" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Timer className="size-3.5" /> Delay between {verb}s (sec)
        </Label>
        <Input
          id="follow-delay"
          type="number"
          min={0}
          max={86400}
          value={value.delaySec}
          onChange={(e) => patch({ delaySec: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        />
        <p className="text-[11px] text-muted-foreground">Pause applied between each {verb} to look human.</p>
      </div>

      {/* Target usernames */}
      <div className="space-y-2">
        <Label htmlFor="follow-usernames" className="text-xs text-muted-foreground">
          Target usernames
        </Label>
        <Textarea
          id="follow-usernames"
          rows={6}
          placeholder={"username1\nusername2\nusername3"}
          className="max-h-60 resize-y font-mono text-xs"
          value={rawUsernames}
          onChange={(e) => {
            setRawUsernames(e.target.value)
            patch({ usernames: parseUsernames(e.target.value) })
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          One per line (or separated by commas/spaces). The leading @ is optional.{" "}
          <span className="font-medium text-foreground">{value.usernames.length}</span> unique target
          {value.usernames.length === 1 ? "" : "s"}.
        </p>
      </div>
    </div>
  )
}
