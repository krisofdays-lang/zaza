import { PageSkeleton } from "@/components/page-skeleton"

export default function Loading() {
  return (
    <PageSkeleton
      title="Warm up"
      description="Imitate real activity to warm up accounts — scroll the feed and interact at human-like rates."
      rows={4}
    />
  )
}
