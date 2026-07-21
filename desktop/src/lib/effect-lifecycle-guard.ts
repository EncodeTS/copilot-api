export interface EffectLifecycleGuard {
  begin: () => number
  current: () => number | null
  end: (lifecycle: number) => void
  isCurrent: (lifecycle: number) => boolean
}

export function createEffectLifecycleGuard(): EffectLifecycleGuard {
  let activeLifecycle: number | null = null
  let nextLifecycle = 0

  return {
    begin: () => {
      nextLifecycle += 1
      activeLifecycle = nextLifecycle
      return activeLifecycle
    },
    current: () => activeLifecycle,
    end: (lifecycle) => {
      if (activeLifecycle === lifecycle) activeLifecycle = null
    },
    isCurrent: (lifecycle) => activeLifecycle === lifecycle,
  }
}
