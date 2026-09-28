import { redirect } from "next/navigation"
import { WorkflowEditor } from "@/components/workflows/workflow-editor"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { getMediaForPicker } from "@/app/actions/storage"
import { getWorkflow, createWorkflow } from "@/app/actions/workflows"

export const dynamic = "force-dynamic"

export default async function WorkflowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // "new" (or any non-numeric id) creates a fresh workflow and redirects to its
  // real id so the editor always works against a persisted row.
  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    const { id: newId } = await createWorkflow()
    redirect(`/workflows/${newId}`)
  }

  const [detail, accounts, media] = await Promise.all([getWorkflow(numericId), getAccountsForDisplay(), getMediaForPicker()])
  if (!detail) redirect("/workflows")

  return (
    <WorkflowEditor
      workflowId={numericId}
      detail={detail}
      accounts={accounts.map((a) => ({
        id: a.id,
        label: a.label || a.username || `Account ${a.id}`,
        username: a.username || "",
        proxyUrl: a.proxyUrl || "",
        rotationUrl: a.rotationUrl || "",
      }))}
        media={media.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          blobUrl: m.blobUrl,
          usedByAccountId: m.usedByAccountId,
        }))}
    />
  )
}
