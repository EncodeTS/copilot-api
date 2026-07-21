import type { ModelMappingRow } from '../lib/model-mappings-editor'
import { formatModelMappingsDiagnostic } from '../lib/model-mappings-editor'

interface ModelMappingRowEditorProps {
  onChange: (field: 'source' | 'target', value: string) => void
  onRemove: () => void
  removeLabel: string
  row: ModelMappingRow
  sourceLabel: string
  targetLabel: string
}

export function ModelMappingRowEditor({
  onChange,
  onRemove,
  removeLabel,
  row,
  sourceLabel,
  targetLabel,
}: ModelMappingRowEditorProps) {
  const invalid = Boolean(row.diagnostics?.length)
  const inputClass = `h-8 w-full rounded-md border bg-sunken px-2.5 text-[13px] text-ink placeholder-ink-faint transition-colors focus:bg-surface focus:outline-none focus:ring-2 ${invalid ? 'border-red-400 focus:ring-red-400/40 dark:border-red-500/70' : 'border-line focus:ring-accent/40'}`

  return (
    <div className="grid gap-2 px-3 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] lg:items-center">
      <label className="block min-w-0">
        <div className="mb-1 text-[12px] font-medium text-ink-soft lg:hidden">
          {sourceLabel}
        </div>
        <input
          type="text"
          value={row.source}
          onChange={(event) => onChange('source', event.target.value)}
          placeholder="gpt-5.5"
          aria-invalid={invalid}
          className={inputClass}
        />
      </label>

      <label className="block min-w-0">
        <div className="mb-1 text-[12px] font-medium text-ink-soft lg:hidden">
          {targetLabel}
        </div>
        <input
          type="text"
          value={row.target}
          onChange={(event) => onChange('target', event.target.value)}
          placeholder="codex/gpt-5.5"
          aria-invalid={invalid}
          className={inputClass}
        />
      </label>

      <button
        onClick={onRemove}
        className="inline-flex h-8 items-center justify-center rounded-md border border-red-200 px-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-500/15"
      >
        {removeLabel}
      </button>

      {row.diagnostics?.length ?
        <div className="lg:col-span-3 space-y-1" role="alert">
          {row.diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.code}-${index}`}
              className="break-all font-mono text-[11px] text-red-600 dark:text-red-400"
            >
              {formatModelMappingsDiagnostic(diagnostic)}
            </div>
          ))}
        </div>
      : null}
    </div>
  )
}
