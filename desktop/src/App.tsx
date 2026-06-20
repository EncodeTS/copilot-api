import { useState, useEffect } from 'react'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'
import { useLanguage } from './contexts/LanguageContext'
import type { AuthResult, DesktopAuthMode } from './types/ipc'

export type Page = 'auth' | 'dashboard'

function BootScreen({ loadingText }: { loadingText: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#0f172a] text-base font-extrabold text-white shadow-[0_10px_30px_rgba(15,23,42,0.16)]">
          CA
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-bold text-[#0f172a]">Copilot API</h1>
          <p className="text-[13px] text-slate-500">{loadingText}</p>
        </div>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-[#0f172a]" />
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page | null>(null)
  const [authMode, setAuthMode] = useState<DesktopAuthMode>('none')
  const [canReturnFromAuth, setCanReturnFromAuth] = useState(false)
  const [port, setPort] = useState<number>(4141)
  const { setLangPref, t } = useLanguage()

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const [authResult, settings] = await Promise.all([
          window.electronAPI.getAuthStatus(),
          window.electronAPI.getSettings(),
        ])

        if (!active) return

        setPort(settings.lastPort)
        setLangPref(settings.language ?? 'auto')

        if (authResult.success && authResult.mode !== 'none') {
          setAuthMode(authResult.mode)
          setCanReturnFromAuth(false)
          setPage('dashboard')
          return
        }

        setCanReturnFromAuth(false)
        setPage('auth')
      } catch {
        if (active) {
          setCanReturnFromAuth(false)
          setPage('auth')
        }
      }
    }

    void bootstrap()

    return () => {
      active = false
    }
  }, [])

  const handleAuthSuccess = (result: AuthResult) => {
    setAuthMode(result.mode ?? 'provider')
    setCanReturnFromAuth(false)
    setPage('dashboard')
  }

  const handleChangeAuth = () => {
    setCanReturnFromAuth(true)
    setPage('auth')
  }

  const handleBackToDashboard = () => {
    setCanReturnFromAuth(false)
    setPage('dashboard')
  }

  if (page === null) {
    return <BootScreen loadingText={t('auth.loading')} />
  }

  if (page === 'auth') {
    return (
      <AuthPage
        onBack={canReturnFromAuth ? handleBackToDashboard : undefined}
        onSuccess={handleAuthSuccess}
      />
    )
  }

  return (
    <DashboardPage
      authMode={authMode}
      defaultPort={port}
      onChangeAuth={handleChangeAuth}
    />
  )
}
