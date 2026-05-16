import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'

interface AdvancedConfigPageProps {
  onBack: () => void
  serverRunning: boolean
}

interface ModelMappingRow {
  id: string
  source: string
  target: string
}

function createModelMappingRow(source = '', target = ''): ModelMappingRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    target,
  }
}

function toRows(modelMappings: Record<string, string>): ModelMappingRow[] {
  return Object.entries(modelMappings).map(([source, target]) =>
    createModelMappingRow(source, target),
  )
}

export default function AdvancedConfigPage({ onBack, serverRunning }: AdvancedConfigPageProps) {
  const { t } = useLanguage()
  const translationRef = useRef(t)
  const [configPath, setConfigPath] = useState('')
  const [rows, setRows] = useState<ModelMappingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveMessage, setSaveMessage] = useState('')

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

        setConfigPath(result.configPath)
        setRows(toRows(result.modelMappings))
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
        row.id === id ? { ...row, [field]: value } : row,
      ),
    )
    setError('')
    setSaveMessage('')
  }

  const handleAddRow = () => {
    setRows((currentRows) => [...currentRows, createModelMappingRow()])
    setError('')
    setSaveMessage('')
  }

  const handleRemoveRow = (id: string) => {
    setRows((currentRows) => currentRows.filter((row) => row.id !== id))
    setError('')
    setSaveMessage('')
  }

  const buildModelMappings = (): Record<string, string> | null => {
    const modelMappings: Record<string, string> = {}

    for (const row of rows) {
      if (!row.source && !row.target) {
        continue
      }

      if (!row.source || !row.target) {
        setError(t('advancedConfig.validationIncomplete'))
        return null
      }

      if (Object.hasOwn(modelMappings, row.source)) {
        setError(t('advancedConfig.validationDuplicate', { model: row.source }))
        return null
      }

      modelMappings[row.source] = row.target
    }

    return modelMappings
  }

  const handleSave = async () => {
    setError('')
    setSaveMessage('')

    const nextModelMappings = buildModelMappings()
    if (!nextModelMappings) {
      return
    }

    setSaving(true)
    try {
      await window.electronAPI.saveModelMappings(nextModelMappings)
      setRows(toRows(nextModelMappings))
      setSaveMessage(t('advancedConfig.saved'))
    } catch (err) {
      setError(`${t('advancedConfig.saveFailed')}: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-full bg-slate-50 px-6 py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-500 shadow-sm">
              {t('header.advancedConfig')}
            </div>
            <div>
              <h1 className="text-[24px] font-bold text-[#0f172a]">
                {t('advancedConfig.title')}
              </h1>
              <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-500">
                {t('advancedConfig.subtitle')}
              </p>
            </div>
          </div>

          <button
            onClick={onBack}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-100"
          >
            {t('advancedConfig.back')}
          </button>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 shadow-sm">
            {error}
          </div>
        )}

        {saveMessage && !error && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-sm">
            {saveMessage}
          </div>
        )}

        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1.5">
              <h2 className="text-[16px] font-semibold text-[#0f172a]">
                {t('advancedConfig.modelMappingsTitle')}
              </h2>
              <p className="max-w-3xl text-[13px] leading-relaxed text-slate-500">
                {t('advancedConfig.modelMappingsDesc')}
              </p>
            </div>

            <button
              onClick={handleAddRow}
              disabled={!serverRunning}
              className="inline-flex items-center justify-center rounded-xl bg-[#0f172a] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('advancedConfig.addMapping')}
            </button>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {t('advancedConfig.scopeLabel')}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
                {t('advancedConfig.scopeNote')}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-emerald-700">
                {t('advancedConfig.restartNote')}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {t('advancedConfig.configPath')}
              </div>
              <div className="mt-2 break-all rounded-xl bg-white px-3 py-2 font-mono text-[12px] text-slate-600 shadow-sm">
                {configPath || '—'}
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-[13px] text-slate-400">
                {t('dashboard.loading')}
              </div>
            ) : rows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center">
                <div className="text-[14px] font-semibold text-[#0f172a]">
                  {t('advancedConfig.emptyTitle')}
                </div>
                <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-slate-500">
                  {t('advancedConfig.emptyDescription')}
                </p>
              </div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.id}
                  className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
                >
                  <label className="block">
                    <div className="mb-1.5 text-[12px] font-medium text-slate-500">
                      {t('advancedConfig.sourceModel')}
                    </div>
                    <input
                      type="text"
                      value={row.source}
                      onChange={(event) =>
                        handleRowChange(row.id, 'source', event.target.value)
                      }
                      placeholder="claude-opus-4-7"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-[#0f172a] placeholder-slate-300 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
                    />
                  </label>

                  <label className="block">
                    <div className="mb-1.5 text-[12px] font-medium text-slate-500">
                      {t('advancedConfig.targetModel')}
                    </div>
                    <input
                      type="text"
                      value={row.target}
                      onChange={(event) =>
                        handleRowChange(row.id, 'target', event.target.value)
                      }
                      placeholder="gpt-5-mini"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-[#0f172a] placeholder-slate-300 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
                    />
                  </label>

                  <button
                    onClick={() => handleRemoveRow(row.id)}
                    className="inline-flex items-center justify-center rounded-xl border border-red-200 px-3 py-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50"
                  >
                    {t('advancedConfig.remove')}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
          <p className="text-[13px] leading-relaxed text-slate-500">
            {t('advancedConfig.saveHelp')}
          </p>
          <button
            onClick={handleSave}
            disabled={!serverRunning || loading || saving}
            className="inline-flex items-center justify-center rounded-xl bg-[#0f172a] px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
