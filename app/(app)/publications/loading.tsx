import { PageSkeleton } from "@/components/page-skeleton"

export default function Loading() {
  return (
    <PageSkeleton
      title="Publications"
      description="Compose Reels, Posts, Stories and Highlights, then publish to accounts or a whole group."
      rows={3}
    />
  )
}
