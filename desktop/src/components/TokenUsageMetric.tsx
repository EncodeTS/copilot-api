export type TokenUsageMetricValue = string | readonly string[]

function getTokenUsageValueLines(value: TokenUsageMetricValue): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

export function TokenUsageValueLines({ value }: { value: TokenUsageMetricValue }) {
  const lines = getTokenUsageValueLines(value)

  return (
    <>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className="block whitespace-nowrap">
          {line}
        </span>
      ))}
    </>
  )
}

export function TokenUsageMetric({ label, loading, tone, value }: {
  label: string
  loading: boolean
  tone: 'amber' | 'blue' | 'cyan' | 'green' | 'slate' | 'violet'
  value: TokenUsageMetricValue
}) {
  const toneClasses = {
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    cyan: 'bg-cyan-50 border-cyan-200 text-cyan-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    slate: 'bg-slate-50 border-slate-200 text-[#0f172a]',
    violet: 'bg-violet-50 border-violet-200 text-violet-700'
  }[tone]
  const title = getTokenUsageValueLines(value).join('\n')

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${toneClasses}`}>
      <div
        className={`text-[13px] font-bold leading-4 ${
          loading ? 'animate-pulse opacity-40' : ''
        }`}
        title={title}
      >
        {loading ? '…' : <TokenUsageValueLines value={value} />}
      </div>
      <div className="mt-1 text-[13px] leading-4 opacity-70">{label}</div>
    </div>
  )
}

export function TokenUsageCostMetric({ label, loading, value }: {
  label: string
  loading: boolean
  value: TokenUsageMetricValue
}) {
  const title = getTokenUsageValueLines(value).join('\n')

  return (
    <div className="min-h-[72px] rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-700">
      <div className="text-[13px] leading-4 opacity-70">{label}</div>
      <div
        className={`mt-1 min-h-[2rem] text-[13px] font-bold leading-4 ${
          loading ? 'animate-pulse opacity-40' : ''
        }`}
        title={title}
      >
        {loading ? '…' : <TokenUsageValueLines value={value} />}
      </div>
    </div>
  )
}
