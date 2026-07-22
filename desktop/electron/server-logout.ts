export interface ServerLogoutDependencies {
  clearRestartContext: () => void
  clearToken: () => Promise<void>
  markCredentialsChanged: () => void
  stopServer: () => Promise<void>
}

export const logoutDesktopServerSession = async (
  dependencies: ServerLogoutDependencies,
): Promise<void> => {
  dependencies.clearRestartContext()
  await dependencies.stopServer()
  await dependencies.clearToken()
  dependencies.markCredentialsChanged()
}
