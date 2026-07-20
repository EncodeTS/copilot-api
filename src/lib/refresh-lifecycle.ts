import { AuthTransportError } from "~/lib/auth-request"

export interface RefreshLifecycleLease<Scope extends string> {
  readonly lifecycleEpoch: number
  readonly scope: Scope
  readonly signal: AbortSignal
}

interface InternalLease<Scope extends string>
  extends RefreshLifecycleLease<Scope> {
  readonly controller: AbortController
  readonly detachCallerSignal: () => void
}

interface SetupLifecycleFlight<Scope extends string>
  extends RefreshLifecycleFlight<Scope, void> {
  waiterCount: number
}

export interface RefreshLifecycleFlight<Scope extends string, Value> {
  readonly lease: RefreshLifecycleLease<Scope>
  readonly promise: Promise<Value>
}

export class RefreshLifecycle<Scope extends string, RefreshValue> {
  private activeLease: InternalLease<Scope> | null = null
  private lifecycleEpoch = 0
  private refreshFlight: RefreshLifecycleFlight<Scope, RefreshValue> | null =
    null
  private setupFlight: SetupLifecycleFlight<Scope> | null = null
  private readonly label: string
  private readonly scope: Scope

  constructor(scope: Scope, label: string) {
    this.scope = scope
    this.label = label
  }

  getActiveLease(): RefreshLifecycleLease<Scope> | null {
    return this.activeLease
  }

  getRefreshFlight(): RefreshLifecycleFlight<Scope, RefreshValue> | null {
    return this.refreshFlight
  }

  getSetupFlight(): RefreshLifecycleFlight<Scope, void> | null {
    return this.setupFlight
  }

  waitForSetup(signal?: AbortSignal): Promise<void> {
    const flight = this.setupFlight
    if (!flight) return Promise.resolve()
    flight.waiterCount += 1
    let waiterAborted = false
    return this.waitFor(flight.promise, signal)
      .catch((error: unknown) => {
        waiterAborted = signal?.aborted === true
        throw error
      })
      .finally(() => {
        flight.waiterCount -= 1
        if (
          waiterAborted
          && flight.waiterCount === 0
          && this.setupFlight === flight
        ) {
          this.cancel(flight.lease)
        }
      })
  }

  stop(): void {
    this.lifecycleEpoch += 1
    this.activeLease?.controller.abort()
    this.activeLease?.detachCallerSignal()
    this.activeLease = null
    this.refreshFlight = null
    this.setupFlight = null
  }

  beginExclusive(
    options: {
      linkSignal?: boolean
      signal?: AbortSignal
    } = {},
  ): RefreshLifecycleLease<Scope> {
    this.stop()
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    if (options.linkSignal) {
      options.signal?.addEventListener("abort", onCallerAbort, { once: true })
      if (options.signal?.aborted) controller.abort()
    }
    const lease: InternalLease<Scope> = {
      controller,
      detachCallerSignal: () =>
        options.signal?.removeEventListener("abort", onCallerAbort),
      lifecycleEpoch: this.lifecycleEpoch,
      scope: this.scope,
      signal: controller.signal,
    }
    this.activeLease = lease
    return lease
  }

  isCurrent(lease: RefreshLifecycleLease<Scope>): boolean {
    return this.activeLease === lease && !lease.signal.aborted
  }

  assertCurrent(lease: RefreshLifecycleLease<Scope>): void {
    if (!this.isCurrent(lease)) {
      throw new AuthTransportError(
        `${this.label} lifecycle was aborted`,
        "aborted",
      )
    }
  }

  release(lease: RefreshLifecycleLease<Scope>): void {
    if (this.activeLease !== lease) return
    this.activeLease.detachCallerSignal()
    this.activeLease = null
  }

  cancel(lease: RefreshLifecycleLease<Scope>): void {
    if (this.activeLease !== lease) return
    this.stop()
  }

  async waitFor<Value>(
    promise: Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    if (!signal) return await promise
    if (signal.aborted) {
      throw new AuthTransportError(
        `${this.label} waiter was aborted`,
        "aborted",
      )
    }

    let rejectWaiter: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectWaiter = () =>
        reject(
          new AuthTransportError(`${this.label} waiter was aborted`, "aborted"),
        )
      signal.addEventListener("abort", rejectWaiter, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      if (rejectWaiter) signal.removeEventListener("abort", rejectWaiter)
    }
  }

  runSetup(
    signal: AbortSignal | undefined,
    operation: (lease: RefreshLifecycleLease<Scope>) => Promise<void>,
  ): Promise<void> {
    if (this.setupFlight) {
      return this.waitForSetup(signal)
    }
    if (signal?.aborted) {
      return Promise.reject(
        new AuthTransportError(`${this.label} waiter was aborted`, "aborted"),
      )
    }

    const lease = this.beginExclusive()
    const promise = operation(lease)
    const flight: SetupLifecycleFlight<Scope> = {
      lease,
      promise,
      waiterCount: 0,
    }
    this.setupFlight = flight
    promise.then(
      () => {
        if (this.setupFlight === flight) this.setupFlight = null
      },
      () => {
        if (this.setupFlight === flight) this.setupFlight = null
        this.release(lease)
      },
    )
    return this.waitForSetup(signal)
  }

  runRefresh(
    lease: RefreshLifecycleLease<Scope>,
    operation: () => Promise<RefreshValue>,
  ): Promise<RefreshValue> {
    if (
      this.refreshFlight
      && this.refreshFlight.lease.lifecycleEpoch === lease.lifecycleEpoch
    ) {
      return this.refreshFlight.promise
    }
    this.assertCurrent(lease)
    const promise = operation()
    const flight: RefreshLifecycleFlight<Scope, RefreshValue> = {
      lease,
      promise,
    }
    this.refreshFlight = flight
    promise.then(
      () => {
        if (this.refreshFlight === flight) this.refreshFlight = null
      },
      () => {
        if (this.refreshFlight === flight) this.refreshFlight = null
      },
    )
    return promise
  }
}
