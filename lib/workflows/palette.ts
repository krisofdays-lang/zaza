import {
  Camera,
  Film,
  Image as ImageIcon,
  Star,
  FileText,
  User,
  Link as LinkIcon,
  AtSign,
  ImagePlus,
  Unlink,
  ShieldCheck,
  UserPlus,
  UserMinus,
  MessageSquare,
  ScrollText,
  Clapperboard,
  Sparkles,
  BookOpen,
  Play,
  type LucideIcon,
} from "lucide-react"

// Visual accent per palette category. Values map to theme tokens / Instagram
// hues so the editor stays within the app's color system.
export type CategoryKey = "publications" | "profile" | "strategies" | "feedTraining"

export const CATEGORY_META: Record<CategoryKey, { label: string; color: string }> = {
  publications: { label: "Publications", color: "#fa7e1e" },
  profile: { label: "Profile", color: "#962fbf" },
  strategies: { label: "Strategies", color: "#d62976" },
  feedTraining: { label: "Feed Training", color: "#4f5bd5" },
}

export interface PaletteAction {
  key: string
  label: string
  icon: LucideIcon
  category: CategoryKey
}

// Catalog of draggable action nodes, grouped to match the builder palette.
export const PALETTE: PaletteAction[] = [
  // Publications
  { key: "post_story", label: "Post Story", icon: Camera, category: "publications" },
  { key: "post_reel", label: "Post Reel", icon: Film, category: "publications" },
  { key: "post_media", label: "Post Media", icon: ImageIcon, category: "publications" },
  { key: "create_highlight", label: "Create Highlight", icon: Star, category: "publications" },
  // Profile
  { key: "bio_change", label: "Biography Change", icon: FileText, category: "profile" },
  { key: "name_change", label: "Name Change", icon: User, category: "profile" },
  { key: "link_in_bio", label: "Link in Bio", icon: LinkIcon, category: "profile" },
  { key: "username_change", label: "Username Change", icon: AtSign, category: "profile" },
  { key: "profile_picture", label: "Profile Picture", icon: ImagePlus, category: "profile" },
  { key: "remove_bio_links", label: "Remove Bio Links", icon: Unlink, category: "profile" },
  { key: "account_privacy", label: "Account Privacy", icon: ShieldCheck, category: "profile" },
  // Strategies
  { key: "follow_targets", label: "Follow Targets", icon: UserPlus, category: "strategies" },
  { key: "unfollow_targets", label: "Unfollow Targets", icon: UserMinus, category: "strategies" },
  { key: "comment_posts", label: "Comment on Posts", icon: MessageSquare, category: "strategies" },
  // Feed Training
  { key: "feed_scrolling", label: "Feed Scrolling", icon: ScrollText, category: "feedTraining" },
  { key: "reels_scrolling", label: "Reels Scrolling", icon: Clapperboard, category: "feedTraining" },
  { key: "feed_training", label: "Feed Training", icon: Sparkles, category: "feedTraining" },
  { key: "story_tray", label: "Story Tray", icon: BookOpen, category: "feedTraining" },
]

export const PALETTE_BY_CATEGORY: { key: CategoryKey; label: string; actions: PaletteAction[] }[] = (
  Object.keys(CATEGORY_META) as CategoryKey[]
).map((key) => ({
  key,
  label: CATEGORY_META[key].label,
  actions: PALETTE.filter((a) => a.category === key),
}))

export function getPaletteAction(key: string): PaletteAction | undefined {
  return PALETTE.find((a) => a.key === key)
}

// The Start node icon, exported so the canvas and palette stay in sync.
export const StartIcon = Play
