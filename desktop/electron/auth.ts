import {
  clearGitHubToken,
  readGitHubToken,
} from '../../src/lib/credential-store'
import {
  beginGitHubManualLogin,
  cancelGitHubDeviceLogin,
  cancelGitHubManualLogin,
  persistGitHubManualToken,
  startGitHubDeviceLogin,
  type GitHubDeviceLoginSession,
  type GitHubManualLoginSession,
} from '../../src/lib/github-login'
import type { AuthRequestOptions } from '../../src/lib/auth-request'
import {
  getCopilotAccountType as fetchCopilotAccountType,
  type CopilotAccountType,
} from '../../src/services/github/get-copilot-usage'
import { getGitHubUser as fetchGitHubUser } from '../../src/services/github/get-user'

export { cancelGitHubDeviceLogin, startGitHubDeviceLogin }
export type { GitHubDeviceLoginSession }

export async function getGitHubUser(
  token: string,
  options?: AuthRequestOptions,
): Promise<string> {
  const user = await fetchGitHubUser(token, options)
  return user.login
}

export async function readToken(): Promise<string | null> {
  try {
    return await readGitHubToken()
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  await clearGitHubToken()
}

export async function getCopilotAccountType(
  token: string,
  options?: AuthRequestOptions & { expectedLogin?: string },
): Promise<CopilotAccountType> {
  try {
    return await fetchCopilotAccountType(token, options)
  } catch (error) {
    if (options?.signal?.aborted) throw error
    return 'individual'
  }
}

export interface DesktopGitHubManualLoginDependencies {
  beginLogin: (
    options?: AuthRequestOptions,
  ) => Promise<GitHubManualLoginSession>
  cancelLogin: (session: GitHubManualLoginSession) => void
  getAccountType: (
    token: string,
    options?: AuthRequestOptions & { expectedLogin?: string },
  ) => Promise<CopilotAccountType>
  getUser: (token: string, options?: AuthRequestOptions) => Promise<string>
  persistToken: (
    session: GitHubManualLoginSession,
    token: string,
  ) => Promise<void>
}

const defaultManualLoginDependencies: DesktopGitHubManualLoginDependencies = {
  beginLogin: beginGitHubManualLogin,
  cancelLogin: cancelGitHubManualLogin,
  getAccountType: getCopilotAccountType,
  getUser: getGitHubUser,
  persistToken: persistGitHubManualToken,
}

export async function loginWithGitHubToken(
  token: string,
  dependencyOverrides: Partial<DesktopGitHubManualLoginDependencies> = {},
): Promise<{ accountType: CopilotAccountType; userName: string }> {
  const dependencies: DesktopGitHubManualLoginDependencies = {
    ...defaultManualLoginDependencies,
    ...dependencyOverrides,
  }
  const session = await dependencies.beginLogin()
  try {
    const userName = await dependencies.getUser(token, {
      signal: session.signal,
    })
    const accountType = await dependencies.getAccountType(token, {
      expectedLogin: userName,
      signal: session.signal,
    })
    await dependencies.persistToken(session, token)
    return { accountType, userName }
  } catch (error) {
    dependencies.cancelLogin(session)
    throw error
  }
}
