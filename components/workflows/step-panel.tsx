"use client"

import { useState } from "react"
import { type Node } from "@xyflow/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { X, Play, Clock, Shuffle, Newspaper, Copy, Trash2, Unlink, GitBranch } from "lucide-react"
import { toast } from "sonner"
import type { WfNodeData } from "@/components/workflows/nodes"
import { WarmupKnobs } from "@/components/warmup/warmup-knobs"
import { DEFAULT_WARMUP_CONFIG, type WarmupConfig } from "@/lib/warmup/types"
import { PostReelPanel } from "@/components/workflows/post-reel-panel"
import { FollowTargetsPanel } from "@/components/workflows/follow-targets-panel"
import { AccountPrivacyPanel } from "@/components/workflows/account-privacy-panel"
import { BioChangePanel } from "@/components/workflows/bio-change-panel"
import { NameChangePanel } from "@/components/workflows/name-change-panel"
import { ProfilePicturePanel } from "@/components/workflows/profile-picture-panel"
import { UsernameChangePanel } from "@/components/workflows/username-change-panel"
import { LinkInBioPanel } from "@/components/workflows/link-in-bio-panel"
import { PostMediaPanel } from "@/components/workflows/post-media-panel"
import { StoryPanel } from "@/components/workflows/story-panel"
import { DEFAULT_START_CONFIG, type StartConfig } from "@/lib/workflows/graph"
import { ConcurrencyControl, clampConcurrency } from "@/components/shared/concurrency-control"
import {
  emptyPostReelConfig,
  emptyFollowTargetsConfig,
  emptyAccountPrivacyConfig,
  emptyBioChangeConfig,
  emptyNameChangeConfig,
  emptyProfilePictureConfig,
  emptyUsernameChangeConfig,
  emptyLinkInBioConfig,
  emptyPostMediaConfig,
  emptyPostStoryConfig,
  emptyCreateHighlightConfig,
  type PostReelConfig,
  type FollowTargetsConfig,
  type AccountPrivacyConfig,
  type BioChangeConfig,
  type NameChangeConfig,
  type ProfilePictureConfig,
  type UsernameChangeConfig,
  type LinkInBioConfig,
  type PostMediaConfig,
  type PostStoryConfig,
  type CreateHighlightConfig,
  type WfAccount,
  type WfMedia,
} from "@/lib/workflows/types"

// Action nodes that share the warm-up scrolling behaviour and therefore expose
// the same chance + duration knobs as the Warm up section.
const SCROLL_ACTION_KEYS = new Set(["feed_scrolling", "reels_scrolling", "feed_training", "story_tray"])

export function StepPanel({
  node,
  accounts,
  media,
  onClose,
  onDuplicate,
  onDelete,
  onLabelChange,
  onConfigChange,
}: {
  node: Node
  accounts: WfAccount[]
  media: WfMedia[]
  onClose: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onLabelChange: (label: string) => void
  onConfigChange?: (config: unknown) => void
}) {
  const data = node.data as WfNodeData
  const isStart = node.type === "start"
  const isScroll = SCROLL_ACTION_KEYS.has(data.actionKey)
  const isPostReel = data.actionKey === "post_reel"
  const isFollowTargets = data.actionKey === "follow_targets"
  const isUnfollowTargets = data.actionKey === "unfollow_targets"
  const isAccountPrivacy = data.actionKey === "account_privacy"
  const isBioChange = data.actionKey === "bio_change"
  const isNameChange = data.actionKey === "name_change"
  const isProfilePicture = data.actionKey === "profile_picture"
  const isUsernameChange = data.actionKey === "username_change"
  const isLinkInBio = data.actionKey === "link_in_bio"
  const isRemoveBioLinks = data.actionKey === "remove_bio_links"
  const isPostMedia = data.actionKey === "post_media"
  const isPostStory = data.actionKey === "post_story"
  const isCreateHighlight = data.actionKey === "create_highlight"
  const [name, setName] = useState(data.label ?? "")
  const [repeat, setRepeat] = useState("once")
  const [start, setStart] = useState("09:00")
  const [end, setEnd] = useState("18:00")
  // Start-node execution config (persisted on the node). delayMs is shown to the
  // user in seconds; naturalBehavior is the repurposed "Randomize" toggle.
  const startCfgInit = (data.config as Partial<StartConfig> | undefined) ?? {}
  // Between-steps delay is a random range now. Fall back to the legacy fixed
  // `delayMs` for both bounds so old saved configs open as a fixed range.
  const initDelayMinMs =
    typeof startCfgInit.delayMinMs === "number"
      ? startCfgInit.delayMinMs
      : typeof startCfgInit.delayMs === "number"
        ? startCfgInit.delayMs
        : DEFAULT_START_CONFIG.delayMs
  const initDelayMaxMs =
    typeof startCfgInit.delayMaxMs === "number"
      ? startCfgInit.delayMaxMs
      : typeof startCfgInit.delayMs === "number"
        ? startCfgInit.delayMs
        : DEFAULT_START_CONFIG.delayMs
  const [delayMinSec, setDelayMinSec] = useState(Math.round(initDelayMinMs / 1000))
  const [delayMaxSec, setDelayMaxSec] = useState(Math.round(initDelayMaxMs / 1000))
  const [naturalBehavior, setNaturalBehavior] = useState(Boolean(startCfgInit.naturalBehavior))
  const [concurrency, setConcurrency] = useState(
    typeof startCfgInit.concurrency === "number" && startCfgInit.concurrency >= 1
      ? startCfgInit.concurrency
      : DEFAULT_START_CONFIG.concurrency,
  )
  // Random between-accounts pause, shown to the user in seconds.
  const [accPauseMinSec, setAccPauseMinSec] = useState(
    Math.round(
      (typeof startCfgInit.accountPauseMinMs === "number"
        ? startCfgInit.accountPauseMinMs
        : DEFAULT_START_CONFIG.accountPauseMinMs) / 1000,
    ),
  )
  const [accPauseMaxSec, setAccPauseMaxSec] = useState(
    Math.round(
      (typeof startCfgInit.accountPauseMaxMs === "number"
        ? startCfgInit.accountPauseMaxMs
        : DEFAULT_START_CONFIG.accountPauseMaxMs) / 1000,
    ),
  )
  // Total window (seconds) over which parallel account starts are spread evenly.
  // Falls back to the legacy max range for old saved graphs so they keep working.
  const [laneStaggerWindowSec, setLaneStaggerWindowSec] = useState(
    Math.round(
      (typeof startCfgInit.laneStaggerWindowMs === "number" && startCfgInit.laneStaggerWindowMs > 0
        ? startCfgInit.laneStaggerWindowMs
        : typeof startCfgInit.laneStaggerMaxMs === "number"
          ? startCfgInit.laneStaggerMaxMs
          : DEFAULT_START_CONFIG.laneStaggerWindowMs) / 1000,
    ),
  )
  // Global minimum gap (seconds) enforced between ANY two posts across all lanes
  // — the only setting that actually guarantees publishes can't collide.
  const [publishGapMinSec, setPublishGapMinSec] = useState(
    Math.round(
      (typeof startCfgInit.publishGapMinMs === "number"
        ? startCfgInit.publishGapMinMs
        : DEFAULT_START_CONFIG.publishGapMinMs) / 1000,
    ),
  )
  const [publishGapMaxSec, setPublishGapMaxSec] = useState(
    Math.round(
      (typeof startCfgInit.publishGapMaxMs === "number"
        ? startCfgInit.publishGapMaxMs
        : DEFAULT_START_CONFIG.publishGapMaxMs) / 1000,
    ),
  )
  // Push the Start config up whenever delay, natural behaviour, concurrency, the
  // between-accounts pause, the parallel stagger or the publish gap changes.
  function emitStart(next: {
    delayMinSec?: number
    delayMaxSec?: number
    naturalBehavior?: boolean
    concurrency?: number
    accPauseMinSec?: number
    accPauseMaxSec?: number
    laneStaggerWindowSec?: number
    publishGapMinSec?: number
    publishGapMaxSec?: number
  }) {
    const dMin = next.delayMinSec ?? delayMinSec
    const dMax = next.delayMaxSec ?? delayMaxSec
    const natural = next.naturalBehavior ?? naturalBehavior
    const conc = next.concurrency ?? concurrency
    const pMin = next.accPauseMinSec ?? accPauseMinSec
    const pMax = next.accPauseMaxSec ?? accPauseMaxSec
    const windowSec = next.laneStaggerWindowSec ?? laneStaggerWindowSec
    const windowMs = Math.max(0, windowSec) * 1000
    const gapMin = next.publishGapMinSec ?? publishGapMinSec
    const gapMax = next.publishGapMaxSec ?? publishGapMaxSec
    onConfigChange?.({
      // Keep the legacy fixed field in sync (= min) for anything still reading it.
      delayMs: Math.max(0, dMin) * 1000,
      delayMinMs: Math.max(0, dMin) * 1000,
      delayMaxMs: Math.max(0, dMax) * 1000,
      naturalBehavior: natural,
      concurrency: conc,
      accountPauseMinMs: Math.max(0, pMin) * 1000,
      accountPauseMaxMs: Math.max(0, pMax) * 1000,
      // Legacy range mirrors the window so old readers still spread starts.
      laneStaggerMinMs: 0,
      laneStaggerMaxMs: windowMs,
      laneStaggerWindowMs: windowMs,
      publishGapMinMs: Math.max(0, gapMin) * 1000,
      publishGapMaxMs: Math.max(0, gapMax) * 1000,
    } satisfies StartConfig)
  }
  const [config, setConfig] = useState<WarmupConfig>(
    (data.config as WarmupConfig | undefined) ?? DEFAULT_WARMUP_CONFIG,
  )
  const [reelConfig, setReelConfig] = useState<PostReelConfig>(
    (data.config as PostReelConfig | undefined)?.assignments ? (data.config as PostReelConfig) : emptyPostReelConfig(),
  )
  const [followConfig, setFollowConfig] = useState<FollowTargetsConfig>(
    (data.config as FollowTargetsConfig | undefined)?.usernames
      ? (data.config as FollowTargetsConfig)
      : emptyFollowTargetsConfig(),
  )
  const [privacyConfig, setPrivacyConfig] = useState<AccountPrivacyConfig>(
    (data.config as AccountPrivacyConfig | undefined)?.publicAccountIds
      ? (data.config as AccountPrivacyConfig)
      : emptyAccountPrivacyConfig(),
  )
  const [bioConfig, setBioConfig] = useState<BioChangeConfig>(
    (data.config as BioChangeConfig | undefined)?.bios ? (data.config as BioChangeConfig) : emptyBioChangeConfig(),
  )
  const [nameConfig, setNameConfig] = useState<NameChangeConfig>(
    (data.config as NameChangeConfig | undefined)?.names ? (data.config as NameChangeConfig) : emptyNameChangeConfig(),
  )
  const [pfpConfig, setPfpConfig] = useState<ProfilePictureConfig>(
    (data.config as ProfilePictureConfig | undefined)?.assignments
      ? (data.config as ProfilePictureConfig)
      : emptyProfilePictureConfig(),
  )
  const [usernameConfig, setUsernameConfig] = useState<UsernameChangeConfig>(
    (data.config as UsernameChangeConfig | undefined)?.usernames
      ? (data.config as UsernameChangeConfig)
      : emptyUsernameChangeConfig(),
  )
  const [linkConfig, setLinkConfig] = useState<LinkInBioConfig>(
    (data.config as LinkInBioConfig | undefined)?.links ? (data.config as LinkInBioConfig) : emptyLinkInBioConfig(),
  )
  const [postMediaConfig, setPostMediaConfig] = useState<PostMediaConfig>(
    (data.config as PostMediaConfig | undefined)?.assignments
      ? (data.config as PostMediaConfig)
      : emptyPostMediaConfig(),
  )
  const [postStoryConfig, setPostStoryConfig] = useState<PostStoryConfig>(
    (data.config as PostStoryConfig | undefined)?.assignments
      ? (data.config as PostStoryConfig)
      : emptyPostStoryConfig(),
  )
  const [highlightConfig, setHighlightConfig] = useState<CreateHighlightConfig>(
    (data.config as CreateHighlightConfig | undefined)?.assignments
      ? (data.config as CreateHighlightConfig)
      : emptyCreateHighlightConfig(),
  )

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Clock className="size-3.5" />
          </span>
          Edit Step
        </h2>
        <div className="flex items-center gap-1">
          {/* Duplicate the whole step with its filled-in data. Start is unique. */}
          {!isStart && onDuplicate && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="Duplicate step"
              aria-label="Duplicate step"
              onClick={onDuplicate}
            >
              <Copy className="size-4" />
            </Button>
          )}
          {/* Delete this step (Start is the entry point and can't be removed). */}
          {!isStart && onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              title="Delete step"
              aria-label="Delete step"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/* Step name */}
        <div className="space-y-2">
          <Label htmlFor="step-name">Step Name (optional)</Label>
          <Input
            id="step-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              onLabelChange(e.target.value || data.label)
            }}
          />
        </div>

        {/* Warm-up scrolling knobs (Feed Scrolling and related action nodes) */}
        {isScroll && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Newspaper className="size-3.5" /> Scroll behaviour
            </p>
            <WarmupKnobs
              config={config}
              compact
              onChange={(next) => {
                setConfig(next)
                onConfigChange?.(next)
              }}
            />
          </div>
        )}

        {/* Post Reel: per-account reel + caption assignments. */}
        {isPostReel && (
          <PostReelPanel
            accounts={accounts}
            media={media}
            value={reelConfig}
            onChange={(next) => {
              setReelConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Post Media: per-account multi-media (1 = post, 2+ = carousel) + caption. */}
        {isPostMedia && (
          <PostMediaPanel
            accounts={accounts}
            media={media}
            value={postMediaConfig}
            onChange={(next) => {
              setPostMediaConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Post Story: per-account single media + optional link sticker. */}
        {isPostStory && (
          <StoryPanel
            mode="story"
            accounts={accounts}
            media={media}
            value={postStoryConfig}
            onChange={(next) => {
              const cfg: PostStoryConfig = { assignments: next.assignments }
              setPostStoryConfig(cfg)
              onConfigChange?.(cfg)
            }}
          />
        )}

        {/* Create Highlight: like Post Story plus a highlight name; posts the
            story then promotes it to a highlight from the archive. */}
        {isCreateHighlight && (
          <StoryPanel
            mode="highlight"
            accounts={accounts}
            media={media}
            value={highlightConfig}
            onChange={(next) => {
              const cfg: CreateHighlightConfig = {
                assignments: next.assignments,
                highlightName: next.highlightName ?? "",
              }
              setHighlightConfig(cfg)
              onConfigChange?.(cfg)
            }}
          />
        )}

        {/* Follow / Unfollow Targets: actions per account, delay, and the target
            username list. Both share the same config shape and claim logic. */}
        {(isFollowTargets || isUnfollowTargets) && (
          <FollowTargetsPanel
            mode={isUnfollowTargets ? "unfollow" : "follow"}
            value={followConfig}
            onChange={(next) => {
              setFollowConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Account Privacy: per-account toggle (default ON = private, OFF = public). */}
        {isAccountPrivacy && (
          <AccountPrivacyPanel
            accounts={accounts}
            value={privacyConfig}
            onChange={(next) => {
              setPrivacyConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Biography Change: per-account new bio (blank = skip that account). */}
        {isBioChange && (
          <BioChangePanel
            accounts={accounts}
            value={bioConfig}
            onChange={(next) => {
              setBioConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Name Change: per-account display name with a global autofill. */}
        {isNameChange && (
          <NameChangePanel
            accounts={accounts}
            value={nameConfig}
            onChange={(next) => {
              setNameConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Profile Picture: per-account image (no caption); blank = skip. */}
        {isProfilePicture && (
          <ProfilePicturePanel
            accounts={accounts}
            media={media}
            value={pfpConfig}
            onChange={(next) => {
              setPfpConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Username Change: per-account new username; blank = skip. */}
        {isUsernameChange && (
          <UsernameChangePanel
            accounts={accounts}
            value={usernameConfig}
            onChange={(next) => {
              setUsernameConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Link in Bio: per-account external link URL; blank = skip. */}
        {isLinkInBio && (
          <LinkInBioPanel
            accounts={accounts}
            value={linkConfig}
            onChange={(next) => {
              setLinkConfig(next)
              onConfigChange?.(next)
            }}
          />
        )}

        {/* Remove Bio Links: no configuration — it clears every link for each
            account selected in the workflow. */}
        {isRemoveBioLinks && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Unlink className="size-3.5" /> Remove bio links
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              This step removes all external links from the bio of every account in this workflow. There is nothing to
              configure — accounts with no links are skipped automatically.
            </p>
          </div>
        )}

        {/* Schedule configuration lives only on the Start node — it controls the
            whole workflow run. Action nodes get their own fields instead. */}
        {isStart && (
          <>
            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Schedule configuration
              </p>

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">Repeat Mode</Label>
                <Select value={repeat} onValueChange={(v) => setRepeat(v ?? "once")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="once">Run Once</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="interval">Interval</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="t-start" className="text-xs text-muted-foreground">
                    Start
                  </Label>
                  <Input id="t-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="t-end" className="text-xs text-muted-foreground">
                    End
                  </Label>
                  <Input id="t-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Estimated duration</p>
                <p className="text-sm font-semibold">
                  ~2 min <span className="font-normal text-muted-foreground">/ 540 min window</span>
                </p>
              </div>
            </div>

            {/* Execution pacing */}
            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Execution
              </p>

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3.5" /> Delay between steps (seconds)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="delay-steps-min"
                    type="number"
                    min={0}
                    aria-label="Minimum delay between steps (seconds)"
                    placeholder="min"
                    value={delayMinSec}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                      setDelayMinSec(v)
                      emitStart({ delayMinSec: v })
                    }}
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    id="delay-steps-max"
                    type="number"
                    min={0}
                    aria-label="Maximum delay between steps (seconds)"
                    placeholder="max"
                    value={delayMaxSec}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                      setDelayMaxSec(v)
                      emitStart({ delayMaxSec: v })
                    }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Nodes always run in the exact order you connect them. A random pause in this range is added before
                  each step for every account. Set both to the same value for a fixed delay.
                </p>
              </div>

              {/* Repurposed "Randomize" -> "Natural behavior" between steps */}
              <label className="flex items-start gap-3 rounded-lg border border-border p-3">
                <Switch
                  checked={naturalBehavior}
                  onCheckedChange={(v) => {
                    setNaturalBehavior(v)
                    emitStart({ naturalBehavior: v })
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Shuffle className="size-3.5" /> Natural behavior
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Between steps the account occasionally scrolls the feed or reels, or checks its own profile, with
                    small random pauses for a more human pattern.
                  </span>
                </span>
              </label>

              {/* Parallelism: how many accounts run at the same time. Governs the
                  whole workflow, so it lives on the Start node. */}
              <ConcurrencyControl
                value={concurrency}
                accountCount={accounts.length}
                onChange={(v) => {
                  const clamped = clampConcurrency(v, accounts.length)
                  setConcurrency(clamped)
                  emitStart({ concurrency: clamped })
                }}
              />

              {/* Random pause between consecutive (sequential) accounts. A value
                  is picked at random in this range after each account within a
                  lane, so accounts don't start on a fixed, detectable cadence. */}
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3.5" /> Random pause between sequential accounts (seconds)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="acc-pause-min"
                    type="number"
                    min={0}
                    aria-label="Minimum pause between sequential accounts (seconds)"
                    placeholder="min"
                    value={accPauseMinSec}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                      setAccPauseMinSec(v)
                      emitStart({ accPauseMinSec: v })
                    }}
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    id="acc-pause-max"
                    type="number"
                    min={0}
                    aria-label="Maximum pause between sequential accounts (seconds)"
                    placeholder="max"
                    value={accPauseMaxSec}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                      setAccPauseMaxSec(v)
                      emitStart({ accPauseMaxSec: v })
                    }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Set both to 0 to disable. A random wait in this range is added after each account before the next one
                  in the same chain starts. Applies to accounts running one after another.
                </p>
              </div>

              {/* Spread PARALLEL account starts EVENLY over a window. Only
                  relevant when concurrency > 1: accounts are distributed across
                  this window (each gets its own slot + jitter) so their post
                  times, timestamps and upload/publish ids don't cluster in the
                  same window (a coordination signal), while no account waits
                  longer than the window itself. */}
              {clampConcurrency(concurrency, accounts.length) > 1 && (
                <div className="space-y-2 rounded-lg border border-[#d62976]/30 bg-[#d62976]/5 p-3">
                  <Label
                    htmlFor="lane-stagger-window"
                    className="flex items-center gap-1.5 text-xs font-medium text-[#d62976]"
                  >
                    <GitBranch className="size-3.5" /> Spread parallel account starts over (seconds)
                  </Label>
                  <Input
                    id="lane-stagger-window"
                    type="number"
                    min={0}
                    aria-label="Window to spread parallel account starts over (seconds)"
                    placeholder="e.g. 300"
                    value={laneStaggerWindowSec}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                      setLaneStaggerWindowSec(v)
                      emitStart({ laneStaggerWindowSec: v })
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Set to 0 to disable (all parallel accounts start together). Accounts are spread{" "}
                    <span className="font-medium">evenly</span> across this window with a small random jitter, so they
                    never post at the same moment — and none waits longer than the window itself.
                    {clampConcurrency(concurrency, accounts.length) > 1 && laneStaggerWindowSec > 0 && (
                      <>
                        {" "}
                        With {clampConcurrency(concurrency, accounts.length)} in parallel that&apos;s ~
                        {Math.round(laneStaggerWindowSec / clampConcurrency(concurrency, accounts.length))}s between
                        starts.
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* Global minimum gap between ANY two posts across all lanes. This
                  is the only setting that GUARANTEES publishes can't collide:
                  every publish step takes a process-wide slot that waits out a
                  fresh random gap since the previous post anywhere. Only shown
                  when running in parallel (with one lane, steps are already
                  serial). Trade-off: guaranteed gap x number of posts = total
                  time, so a large gap over many accounts stretches the run. */}
              {clampConcurrency(concurrency, accounts.length) > 1 && (
                <div className="space-y-2 rounded-lg border border-[#d62976]/30 bg-[#d62976]/5 p-3">
                  <Label className="flex items-center gap-1.5 text-xs font-medium text-[#d62976]">
                    <GitBranch className="size-3.5" /> Minimum gap between publications, across all accounts (seconds)
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      aria-label="Minimum publish gap, lower bound (seconds)"
                      placeholder="min"
                      value={publishGapMinSec}
                      onChange={(e) => {
                        const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                        setPublishGapMinSec(v)
                        emitStart({ publishGapMinSec: v })
                      }}
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                      type="number"
                      min={0}
                      aria-label="Minimum publish gap, upper bound (seconds)"
                      placeholder="max"
                      value={publishGapMaxSec}
                      onChange={(e) => {
                        const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                        setPublishGapMaxSec(v)
                        emitStart({ publishGapMaxSec: v })
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Set to 0 to disable. Unlike the stagger above (which only spreads <span className="font-medium">starts</span>),
                    this enforces a random gap between the actual <span className="font-medium">publish</span> moments of
                    every account — reels, media, stories and highlights — so two publications can never land in the same
                    window, no matter when their lanes started.
                    {publishGapMaxSec > 0 && (
                      <>
                        {" "}
                        Note: with a guaranteed gap, {accounts.length} posts take at least ~
                        {Math.round((accounts.length * (publishGapMinSec + publishGapMaxSec)) / 2 / 60)} min in total.
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>

            {/* Schedule summary */}
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Summary
              </p>
              <p className="mt-1 text-sm font-semibold">
                Run {repeat === "once" ? "once when triggered" : repeat} ({start} - {end})
              </p>
              <p className="mt-0.5 text-xs">
                Steps: <span className="text-primary">sequential</span> ·{" "}
                {delayMinSec === delayMaxSec ? `${delayMinSec}s gap` : `${delayMinSec}-${delayMaxSec}s gap`} ·{" "}
                <span className="text-primary">{naturalBehavior ? "natural behavior on" : "natural behavior off"}</span>
              </p>
              <p className="mt-0.5 text-xs">
                Accounts:{" "}
                <span className="text-primary">
                  {clampConcurrency(concurrency, accounts.length) <= 1
                    ? "one at a time (sequential)"
                    : `${clampConcurrency(concurrency, accounts.length)} in parallel`}
                </span>
              </p>
              <p className="mt-0.5 text-xs">
                Between accounts:{" "}
                <span className="text-primary">
                  {accPauseMaxSec > 0
                    ? accPauseMinSec === accPauseMaxSec
                      ? `${accPauseMaxSec}s pause`
                      : `random ${accPauseMinSec}-${accPauseMaxSec}s pause`
                    : "no extra pause"}
                </span>
              </p>
              {clampConcurrency(concurrency, accounts.length) > 1 && (
                <p className="mt-0.5 text-xs">
                  Parallel stagger:{" "}
                  <span className="text-primary">
                    {laneStaggerWindowSec > 0
                      ? `spread evenly over ${laneStaggerWindowSec}s`
                      : "none (accounts start together)"}
                  </span>
                </p>
              )}
              {clampConcurrency(concurrency, accounts.length) > 1 && (
                <p className="mt-0.5 text-xs">
                  Post spacing:{" "}
                  <span className="text-primary">
                    {publishGapMaxSec > 0
                    ? publishGapMinSec === publishGapMaxSec
                      ? `guaranteed ${publishGapMaxSec}s between publications`
                      : `guaranteed random ${publishGapMinSec}-${publishGapMaxSec}s between publications`
                      : "none (posts may overlap)"}
                  </span>
                </p>
              )}
            </div>

            <p className="text-center text-[11px] text-muted-foreground">
              This is the entry node. Connect actions below it to build the sequence, then press Run.
            </p>
          </>
        )}

        {/* Non-scroll action nodes: their own fields land here later. */}
        {!isStart &&
          !isScroll &&
          !isPostReel &&
          !isFollowTargets &&
          !isUnfollowTargets &&
          !isAccountPrivacy &&
          !isBioChange &&
          !isNameChange &&
          !isProfilePicture &&
          !isUsernameChange &&
          !isLinkInBio &&
          !isRemoveBioLinks &&
          !isPostMedia &&
          !isPostStory &&
          !isCreateHighlight && (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
            Settings for this step are coming soon.
          </p>
        )}
      </div>
    </aside>
  )
}
