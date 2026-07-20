import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  userName?: string
  copilotToken?: string
  codexAccessToken?: string
  codexRefreshToken?: string
  codexExpiresAt?: number
  codexAccountId?: string

  accountType: string
  copilotUsageScope?: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  showToken: boolean

  verbose: boolean

  copilotApiUrl?: string
  tokenBasedBilling?: boolean
}

export const state: State = {
  accountType: "individual",
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}
