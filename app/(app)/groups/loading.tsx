import { GridSkeleton } from "@/components/page-skeleton"

export default function Loading() {
  return <GridSkeleton title="Groups" description="Organize accounts into groups." count={3} />
}
