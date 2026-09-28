import { ACTIONS } from "./actions"

// Plain, serializable action metadata that can cross the server/client boundary
// (the `run` functions in ACTIONS cannot be passed to client components).
export interface ActionMeta {
  key: string
  order: number
  label: string
  description: string
  category: string
  params: { key: string; label: string; type: string; required?: boolean; placeholder?: string }[]
}

export function getActionMeta(): ActionMeta[] {
  return ACTIONS.map((a) => ({
    key: a.key,
    order: a.order,
    label: a.label,
    description: a.description,
    category: a.category,
    params: a.params.map((p) => ({
      key: p.key,
      label: p.label,
      type: p.type,
      required: p.required,
      placeholder: p.placeholder,
    })),
  })).sort((x, y) => x.order - y.order)
}
