import { PageSkeleton } from "@/components/page-skeleton"

export default function Loading() {
  return <PageSkeleton title="Dashboard" description="Manage your Instagram accounts." cards={4} rows={5} />
}
