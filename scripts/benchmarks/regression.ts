import type { BenchmarkReport } from "./types"

export interface RelativeTimingPolicy {
  metric?: "median" | "p95"
  relativeThreshold?: number
  requiredRuns?: number
}

export type RelativeTimingEvaluation =
  | {
      ratios: []
      reason: string
      receivedRuns: number
      requiredRuns: number
      status: "insufficient-runs"
    }
  | {
      ratios: []
      reason: string
      status: "incomparable"
    }
  | {
      ratios: number[]
      reason: string
      regressed: boolean
      status: "evaluated"
    }

export const defaultRelativeTimingPolicy = {
  metric: "median",
  relativeThreshold: 0.2,
  requiredRuns: 3,
} as const satisfies Required<RelativeTimingPolicy>

function comparisonIdentity(report: BenchmarkReport): string {
  const { metadata } = report
  return [
    report.name,
    metadata.fixtureSha256,
    metadata.bun,
    metadata.os,
    metadata.architecture,
    metadata.warmupIterations,
    metadata.iterations,
  ].join("\u0000")
}

function resolvePolicy(policy: RelativeTimingPolicy): {
  metric: "median" | "p95"
  relativeThreshold: number
  requiredRuns: number
} {
  const metric = policy.metric ?? defaultRelativeTimingPolicy.metric
  const relativeThreshold =
    policy.relativeThreshold ?? defaultRelativeTimingPolicy.relativeThreshold
  const requiredRuns =
    policy.requiredRuns ?? defaultRelativeTimingPolicy.requiredRuns

  if (
    !Number.isFinite(relativeThreshold)
    || relativeThreshold < 0
    || relativeThreshold > defaultRelativeTimingPolicy.relativeThreshold
  ) {
    throw new Error(
      `relativeThreshold must be between 0 and the project maximum ${defaultRelativeTimingPolicy.relativeThreshold}`,
    )
  }
  if (
    !Number.isInteger(requiredRuns)
    || requiredRuns < defaultRelativeTimingPolicy.requiredRuns
  ) {
    throw new Error(
      `requiredRuns must be at least ${defaultRelativeTimingPolicy.requiredRuns}`,
    )
  }

  return { metric, relativeThreshold, requiredRuns }
}

export function evaluateRelativeTimingRegression(
  baseline: BenchmarkReport,
  candidates: BenchmarkReport[],
  policy: RelativeTimingPolicy = {},
): RelativeTimingEvaluation {
  const { metric, relativeThreshold, requiredRuns } = resolvePolicy(policy)
  const selectedCandidates = candidates.slice(-requiredRuns)
  if (selectedCandidates.length < requiredRuns) {
    return {
      reason: `need ${requiredRuns} comparable runs; received ${selectedCandidates.length}`,
      ratios: [],
      receivedRuns: selectedCandidates.length,
      requiredRuns,
      status: "insufficient-runs",
    }
  }

  const identity = comparisonIdentity(baseline)
  if (
    selectedCandidates.some(
      (candidate) => comparisonIdentity(candidate) !== identity,
    )
  ) {
    return {
      reason:
        "benchmark runner, fixture, warm-up, or iteration metadata differs",
      ratios: [],
      status: "incomparable",
    }
  }

  const baselineTiming = baseline.timingMilliseconds[metric]
  if (!Number.isFinite(baselineTiming) || baselineTiming <= 0) {
    return {
      reason: `baseline ${metric} must be greater than zero`,
      ratios: [],
      status: "incomparable",
    }
  }

  const ratios = selectedCandidates.map(
    (candidate) => candidate.timingMilliseconds[metric] / baselineTiming,
  )
  const boundary = 1 + relativeThreshold
  const regressed = ratios.every((ratio) => ratio > boundary)

  return {
    reason:
      regressed ?
        `${metric} exceeded the relative threshold in ${requiredRuns} comparable runs`
      : "relative timing regression was not repeated for every required run",
    regressed,
    ratios,
    status: "evaluated",
  }
}
