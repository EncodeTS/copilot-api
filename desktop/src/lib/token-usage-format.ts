const COST_NANOS_PER_UNIT = 1_000_000_000

export interface TokenUsageCostLike {
  amount?: number
  currency?: string
  total_cost_nanos?: number
}

export function formatCostAmount(currency: string, amount: number): string {
  const normalizedCurrency = currency.trim().toUpperCase()
  const symbol = normalizedCurrency === 'USD' ? '$' : normalizedCurrency === 'CNY' ? '¥' : ''
  return symbol ? `${symbol}${amount.toFixed(6)}` : `${normalizedCurrency} ${amount.toFixed(6)}`
}

export function formatTokenCost(cost: TokenUsageCostLike | null | undefined): string {
  const currency = cost?.currency?.trim().toUpperCase()
  if (!currency) return '—'

  const amount =
    typeof cost?.amount === 'number' && Number.isFinite(cost.amount)
      ? cost.amount
      : typeof cost?.total_cost_nanos === 'number' && Number.isFinite(cost.total_cost_nanos)
        ? cost.total_cost_nanos / COST_NANOS_PER_UNIT
        : null

  return amount === null ? '—' : formatCostAmount(currency, amount)
}

export function formatTokenCosts(costs: readonly (TokenUsageCostLike | null | undefined)[] | undefined): string[] {
  if (!costs || costs.length === 0) return ['—']
  return costs.map(cost => formatTokenCost(cost))
}
