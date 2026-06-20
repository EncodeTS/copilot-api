import { useState, useRef, useEffect } from 'react'
import SettingsModal from './SettingsModal'
import { useLanguage } from '../contexts/LanguageContext'

interface HeaderProps {
  onChangeAuth?: () => void
  onRestart?: () => void
  onStop?: () => void
  isRunning?: boolean
  isRestarting?: boolean
  onOpenAdvancedConfig?: () => void
}

export default function Header({
  onChangeAuth,
  onRestart,
  onStop,
  isRunning,
  isRestarting,
  onOpenAdvancedConfig
}: HeaderProps) {
  const { t } = useLanguage()
  const [showSettings, setShowSettings] = useState(false)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const showServerStatus = Boolean(onStop || onOpenAdvancedConfig)

  useEffect(() => {
    if (!showSettingsMenu) return
    const handleOutside = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [showSettingsMenu])

  const handleSettingsAction = () => {
    if (onOpenAdvancedConfig || onChangeAuth) {
      setShowSettingsMenu(v => !v)
      return
    }

    setShowSettings(true)
  }

  return (
    <>
      {/* Placeholder for the macOS traffic lights that keeps the window draggable */}
      <div
        className="h-9 bg-white shrink-0"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ WebkitAppRegion: 'drag' } as any}
      />
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-white">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[#0f172a] rounded-md flex items-center justify-center">
            <span className="text-white text-[9px] font-bold">CA</span>
          </div>
          <span className="text-sm font-bold text-[#0f172a]">Copilot API</span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && onRestart && (
            <button
              onClick={onRestart}
              disabled={isRestarting}
              className="px-2.5 py-1 text-[13px] border border-slate-200 text-slate-600 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {isRestarting ? t('header.restarting') : t('header.restart')}
            </button>
          )}

          {isRunning && onStop && (
            <button
              onClick={onStop}
              className="px-2.5 py-1 text-[13px] border border-red-200 text-red-500 rounded-md hover:bg-red-50 transition-colors"
            >
              {t('header.stop')}
            </button>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[13px] font-semibold text-green-700">{t('header.running')}</span>
            </div>
          ) : showServerStatus ? (
            <div className="flex items-center gap-1.5 bg-yellow-50 border border-yellow-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              <span className="text-[13px] font-semibold text-yellow-700">{t('header.notStarted')}</span>
            </div>
          ) : null}

          <div className="relative" ref={settingsMenuRef}>
            <button
              onClick={handleSettingsAction}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors"
              title={t('header.settings')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>

            {showSettingsMenu && (onOpenAdvancedConfig || onChangeAuth) && (
              <div className="absolute right-0 top-full mt-1.5 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-[170px] overflow-hidden">
                <button
                  onClick={() => {
                    setShowSettingsMenu(false)
                    setShowSettings(true)
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors text-left"
                >
                  {t('header.appSettings')}
                </button>
                {onOpenAdvancedConfig && (
                  <button
                    onClick={() => {
                      setShowSettingsMenu(false)
                      onOpenAdvancedConfig()
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors text-left border-t border-slate-100"
                  >
                    {t('header.advancedConfig')}
                  </button>
                )}
                {onChangeAuth && (
                  <button
                    onClick={() => {
                      setShowSettingsMenu(false)
                      onChangeAuth()
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors text-left border-t border-slate-100"
                  >
                    {t('header.changeAuth')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
