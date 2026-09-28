import { PageSkeleton } from "@/components/page-skeleton"

export default function Loading() {
  return <PageSkeleton title="Analytics" description="Performance metrics across your account strategies." cards={4} rows={5} />
}
