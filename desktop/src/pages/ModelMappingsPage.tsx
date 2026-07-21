import { useEffect, useRef, useState } from 'react'

import { ModelMappingRowEditor } from '../components/ModelMappingRowEditor'
import { useLanguage } from '../contexts/LanguageContext'
import {
  applyModelMappingsDiagnostics,
  buildModelMappingsFromRows,
  createModelMappingRow,
  getModelMappingsSavePresentation,
  modelMappingsToRows,
  type ModelMappingRow,
  type ModelMappingsSavePresentation,
} from '../lib/model-mappings-editor'

interface ModelMappingsPageProps {
  serverRunning: boolean
}

export default function ModelMappingsPage({
  serverRunning,
}: ModelMappingsPageProps) {
  const { t } = useLanguage()
  const translationRef = useRef(t)
  const [configPath, setConfigPath] = useState('')
  const [rows, setRows] = useState<ModelMappingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const [savePresentation, setSavePresentation] =
    useState<ModelMappingsSavePresentation | null>(null)

  useEffect(() => {
    translationRef.current = t
  }, [t])

  useEffect(() => {
    if (serverRunning) {
      return
    }

    setLoading(false)
    setConfigPath('')
    setRows([])
    setSaveMessage('')
    setSavePresentation(null)
    setError(t('advancedConfig.serverRequired'))
  }, [serverRunning, t])

  useEffect(() => {
    if (!serverRunning) {
      return
    }

    let cancelled = false

    const loadModelMappings = async () => {
      setLoading(true)
      setError('')

      try {
        const result = await window.electronAPI.getModelMappingsConfig()
        if (cancelled) {
          return
        }

        if (!result.ok) {
          setError(
            `${translationRef.current('advancedConfig.loadFailed')}: ${result.error.message}`,
          )
          setRows((currentRows) =>
            applyModelMappingsDiagnostics(
              currentRows,
              result.error.diagnostics,
            ),
          )
          return
        }

        setConfigPath(result.config.configPath)
        setRows(modelMappingsToRows(result.config.modelMappings))
      } catch (err) {
        if (cancelled) {
          return
        }

        setError(
          `${translationRef.current('advancedConfig.loadFailed')}: ${(err as Error).message}`,
        )
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadModelMappings()

    return () => {
      cancelled = true
    }
  }, [serverRunning])

  const handleRowChange = (
    id: string,
    field: 'source' | 'target',
    value: string,
  ) => {
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.id === id ?
          { ...row, [field]: value, diagnostics: [] }
        : { ...row, diagnostics: [] },
      ),
    )
    setError('')
    setSaveMessage('')
    setSavePresentation(null)
  }

  const handleAddRow = () => {
    setRows((currentRows) => [
      ...currentRows.map((row) => ({ ...row, diagnostics: [] })),
      createModelMappingRow(),
    ])
    setError('')
    setSaveMessage('')
    setSavePresentation(null)
  }

  const handleRemoveRow = (id: string) => {
    setRows((currentRows) =>
      currentRows
        .filter((row) => row.id !== id)
        .map((row) => ({ ...row, diagnostics: [] })),
    )
    setError('')
    setSaveMessage('')
    setSavePresentation(null)
  }

  const buildModelMappings = (): Record<string, string> | null => {
    const result = buildModelMappingsFromRows(rows)
    if (result.ok) {
      return result.modelMappings
    }

    setRows((currentRows) =>
      applyModelMappingsDiagnostics(currentRows, result.diagnostics),
    )
    if (result.diagnostics[0]?.code === 'duplicate_source') {
      setError(
        t('advancedConfig.validationDuplicate', {
          model: result.diagnostics[0].source ?? '',
        }),
      )
      return null
    }

    setError(t('advancedConfig.validationIncomplete'))
    return null
  }

  const handleSave = async () => {
    setError('')
    setSaveMessage('')
    setSavePresentation(null)

    const nextModelMappings = buildModelMappings()
    if (!nextModelMappings) {
      return
    }

    setSaving(true)
    try {
      const outcome =
        await window.electronAPI.saveModelMappings(nextModelMappings)
      if (!outcome.ok) {
        setRows((currentRows) =>
          applyModelMappingsDiagnostics(currentRows, outcome.error.diagnostics),
        )
        setError(`${t('advancedConfig.saveFailed')}: ${outcome.error.message}`)
        return
      }

      const result = outcome.result
      setRows(modelMappingsToRows(result.modelMappings))
      const presentation = getModelMappingsSavePresentation(result)
      const messages = {
        saved: t('advancedConfig.saved'),
        savedRefreshFailed: t('advancedConfig.savedRefreshFailed'),
        savedRefreshSkipped: t('advancedConfig.savedRefreshSkipped'),
        savedRestartRequired: t('advancedConfig.savedRestartRequired'),
      }
      setSavePresentation(presentation)
      setSaveMessage(
        [
          messages[presentation.messageKey],
          presentation.degradedMessageKey ?
            t('advancedConfig.savedDegraded')
          : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
    } catch (err) {
      setError(`${t('advancedConfig.saveFailed')}: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full bg-canvas p-4 overflow-hidden flex flex-col">
      <div className="relative flex flex-col gap-3 flex-1 min-h-0">
        <div className="shrink-0 flex flex-col gap-3 rounded-lg border border-line bg-surface px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">
              {t('advancedConfig.modelMappingsTitle')}
            </h2>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
              {t('advancedConfig.modelMappingsDesc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleAddRow}
              disabled={!serverRunning}
              className="inline-flex h-8 items-center justify-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('advancedConfig.addMapping')}
            </button>
            <button
              onClick={handleSave}
              disabled={!serverRunning || loading || saving}
              className="inline-flex h-8 items-center justify-center rounded-md bg-accent-strong px-4 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>

        {error && (
          <div className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-400">
            {error}
          </div>
        )}

        {saveMessage && !error && (
          <div
            className={
              savePresentation?.tone === 'error' ?
                'shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-400'
              : savePresentation?.tone === 'info' ?
                'shrink-0 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300'
              : savePresentation?.tone === 'warning' ?
                'shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300'
              : 'shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-400'

            }
          >
            {saveMessage}
          </div>
        )}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] flex-1 min-h-0">
          <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface flex flex-col">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 border-b border-line-soft bg-sunken px-3 py-2 text-[12px] font-semibold text-ink-faint lg:grid shrink-0">
              <div>{t('advancedConfig.sourceModel')}</div>
              <div>{t('advancedConfig.targetModel')}</div>
              <div />
            </div>

            {loading ?
              <div className="px-3 py-8 text-center text-[13px] text-ink-faint">
                {t('dashboard.loading')}
              </div>
            : rows.length === 0 ?
              <div className="px-3 py-10 text-center">
                <div className="text-[14px] font-semibold text-ink">
                  {t('advancedConfig.emptyTitle')}
                </div>
                <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
                  {t('advancedConfig.emptyDescription')}
                </p>
              </div>
            : <div className="divide-y divide-line-soft flex-1 overflow-y-auto">
                {rows.map((row) => (
                  <ModelMappingRowEditor
                    key={row.id}
                    onChange={(field, value) =>
                      handleRowChange(row.id, field, value)
                    }
                    onRemove={() => handleRemoveRow(row.id)}
                    removeLabel={t('advancedConfig.remove')}
                    row={row}
                    sourceLabel={t('advancedConfig.sourceModel')}
                    targetLabel={t('advancedConfig.targetModel')}
                  />
                ))}
              </div>
            }
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            <div className="rounded-lg border border-line bg-surface px-3 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">
                {t('advancedConfig.configPath')}
              </div>
              <div
                className="mt-2 break-all rounded-md bg-sunken px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink-soft"
                title={configPath || undefined}
              >
                {configPath || '—'}
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface px-3 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">
                {t('advancedConfig.scopeLabel')}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                {t('advancedConfig.scopeNote')}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-emerald-700 dark:text-emerald-400">
                {t('advancedConfig.restartNote')}
              </p>
            </div>

            <div className="rounded-lg border border-line bg-surface px-3 py-3 text-[13px] leading-relaxed text-ink-soft">
              {t('advancedConfig.saveHelp')}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
