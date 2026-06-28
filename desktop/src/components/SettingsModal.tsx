import { useState, useEffect } from 'react'
import type { DesktopProxyMode, DesktopSettings, ThemePreference } from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import { useTheme } from '../contexts/ThemeContext'
import { translate, type LangPreference } from '../locales'

interface SettingsModalProps {
  onClose: () => void
}

type Section = 'general' | 'network' | 'startup'

function requiresAppRestart(previous: DesktopSettings, next: DesktopSettings): boolean {
  return previous.apiHome !== next.apiHome
    || previous.oauthApp !== next.oauthApp
    || previous.enterpriseUrl !== next.enterpriseUrl
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-accent-strong' : 'bg-sunken'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5 border-b border-line-soft last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {description && <div className="text-[12px] text-ink-faint mt-0.5 leading-relaxed">{description}</div>}
      </div>
      {children}
    </div>
  )
}

const IconGeneral = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>
  </svg>
)

const IconStartup = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
)

const IconNetwork = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>
  </svg>
)

const IconSun = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
  </svg>
)

const IconMoon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
  </svg>
)

const IconMonitor = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>
  </svg>
)

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { t, setLangPref } = useLanguage()
  const { setThemePref } = useTheme()
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<DesktopSettings>({
    apiHome: '',
    oauthApp: 'default',
    enterpriseUrl: '',
    lastPort: 4141,
    minimizeToTray: false,
    accountType: 'individual',
    verbose: false,
    showToken: false,
    language: 'auto',
    theme: 'auto',
    proxy: {
      mode: 'system',
      http_proxy: 'http://127.0.0.1:8888',
      https_proxy: 'http://127.0.0.1:8888',
      no_proxy: 'localhost,127.0.0.1',
    },
  })
  const [initialSettings, setInitialSettings] = useState<DesktopSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getSettings().then((loadedSettings) => {
      setSettings(loadedSettings)
      setInitialSettings(loadedSettings)
    })
  }, [])

  const handleSave = async () => {
    const shouldPromptRestart = initialSettings !== null && requiresAppRestart(initialSettings, settings)

    setSaving(true)
    try {
      await window.electronAPI.saveSettings(settings)
      setLangPref(settings.language)
      setThemePref(settings.theme)

      if (shouldPromptRestart) {
        window.alert(translate('settings.restartAppPrompt', settings.language, undefined, navigator.language))
      }

      onClose()
    } finally {
      setSaving(false)
    }
  }

  const langOptions: { value: LangPreference; label: string }[] = [
    { value: 'auto', label: t('settings.langAuto') },
    { value: 'en',   label: t('settings.langEn') },
    { value: 'zh',   label: t('settings.langZh') },
  ]

  const themeOptions: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: t('settings.themeLight'), icon: <IconSun /> },
    { value: 'dark',  label: t('settings.themeDark'),  icon: <IconMoon /> },
    { value: 'auto',  label: t('settings.themeAuto'),  icon: <IconMonitor /> },
  ]

  const navItems: { key: Section; label: string; icon: React.ReactNode }[] = [
    { key: 'general',  label: t('settings.sectionGeneral'),  icon: <IconGeneral /> },
    { key: 'network',  label: t('settings.sectionNetwork'),  icon: <IconNetwork /> },
    { key: 'startup',  label: t('settings.sectionStartup'),  icon: <IconStartup /> },
  ]

  const proxyModeOptions: { value: DesktopProxyMode; label: string }[] = [
    { value: 'system', label: t('settings.proxyModeSystem') },
    { value: 'custom', label: t('settings.proxyModeCustom') },
    { value: 'direct', label: t('settings.proxyModeDirect') },
  ]
  const isCustomProxy = settings.proxy.mode === 'custom'

  const handleThemeChange = (value: ThemePreference) => {
    setSettings(s => ({ ...s, theme: value }))
    setThemePref(value)
  }

  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl shadow-xl w-[540px] h-[480px] flex flex-col overflow-hidden ring-1 ring-line-soft">

        {/* Title bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line-soft shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-sunken rounded-lg flex items-center justify-center text-ink-soft">
              <IconGeneral />
            </div>
            <span className="text-[14px] font-semibold text-ink">{t('settings.title')}</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Main content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left navigation */}
          <div className="w-[152px] shrink-0 bg-sunken border-r border-line-soft py-3 px-2 flex flex-col gap-0.5">
            {navItems.map(item => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[13px] transition-colors text-left ${
                  section === item.key
                    ? 'bg-surface shadow-sm font-semibold text-ink'
                    : 'font-medium text-ink-soft hover:text-ink hover:bg-surface/70'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>

          {/* Right panel */}
          <div className="flex-1 overflow-y-auto px-6 py-5">

            {section === 'general' && (
              <div>
                <div className="mb-1">
                  <div className="text-[13px] font-semibold text-ink mb-2">{t('settings.sectionLanguage')}</div>
                  <select
                    value={settings.language}
                    onChange={e => setSettings(s => ({ ...s, language: e.target.value as LangPreference }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 cursor-pointer"
                  >
                    {langOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div className="mb-1 mt-4">
                  <div className="text-[13px] font-semibold text-ink mb-2">{t('settings.sectionTheme')}</div>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-sunken p-1">
                    {themeOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={settings.theme === opt.value}
                        onClick={() => handleThemeChange(opt.value)}
                        className={`flex items-center justify-center gap-1.5 min-h-8 rounded-md px-2 text-[12px] font-medium transition-colors ${
                          settings.theme === opt.value
                            ? 'bg-surface text-ink shadow-sm'
                            : 'text-ink-soft hover:bg-surface/70 hover:text-ink'
                        }`}
                      >
                        {opt.icon}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <SettingRow label={t('settings.minimizeToTray')} description={t('settings.minimizeToTrayDesc')}>
                  <Toggle
                    checked={settings.minimizeToTray}
                    onChange={v => setSettings(s => ({ ...s, minimizeToTray: v }))}
                  />
                </SettingRow>
              </div>
            )}

            {section === 'network' && (
              <div>
                <div className="mb-4 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
                  {t('settings.proxySystemNote')}
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.proxyMode')}</div>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-sunken p-1">
                    {proxyModeOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={settings.proxy.mode === opt.value}
                        onClick={() => setSettings(s => ({ ...s, proxy: { ...s.proxy, mode: opt.value } }))}
                        className={`min-h-8 rounded-md px-2 text-[12px] font-medium transition-colors ${
                          settings.proxy.mode === opt.value
                            ? 'bg-surface text-ink shadow-sm'
                            : 'text-ink-soft hover:bg-surface/70 hover:text-ink'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.httpProxy')}</div>
                  <input
                    type="text"
                    disabled={!isCustomProxy}
                    value={settings.proxy.http_proxy}
                    onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, http_proxy: e.target.value } }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] bg-sunken text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:bg-surface disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  />
                </div>
                <div className="mt-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.httpsProxy')}</div>
                  <input
                    type="text"
                    disabled={!isCustomProxy}
                    value={settings.proxy.https_proxy}
                    onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, https_proxy: e.target.value } }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] bg-sunken text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:bg-surface disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  />
                </div>
                <div className="mt-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.noProxy')}</div>
                  <input
                    type="text"
                    disabled={!isCustomProxy}
                    value={settings.proxy.no_proxy}
                    onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, no_proxy: e.target.value } }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] bg-sunken text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:bg-surface disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  />
                  <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">{t('settings.noProxyDesc')}</p>
                </div>
              </div>
            )}

            {section === 'startup' && (
              <div>
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-400">
                  {t('settings.restartAppNote')}
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.oauthApp')}</div>
                  <select
                    value={settings.oauthApp}
                    onChange={e => setSettings(s => ({ ...s, oauthApp: e.target.value as DesktopSettings['oauthApp'] }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 cursor-pointer"
                  >
                    <option value="default">{t('settings.oauthAppDefault')}</option>
                    <option value="opencode">opencode</option>
                  </select>
                  <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">{t('settings.oauthAppDesc')}</p>
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.apiHome')}</div>
                  <input
                    type="text"
                    placeholder="C:/copilot-api"
                    value={settings.apiHome}
                    onChange={e => setSettings(s => ({ ...s, apiHome: e.target.value }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] bg-sunken text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:bg-surface transition-colors"
                  />
                  <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">{t('settings.apiHomeDesc')}</p>
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-ink mb-1.5">{t('settings.enterpriseUrl')}</div>
                  <input
                    type="text"
                    placeholder="company.ghe.com"
                    value={settings.enterpriseUrl}
                    onChange={e => setSettings(s => ({ ...s, enterpriseUrl: e.target.value }))}
                    className="w-full px-3 py-2 border border-line rounded-lg text-[13px] bg-sunken text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:bg-surface transition-colors"
                  />
                  <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">{t('settings.enterpriseUrlDesc')}</p>
                </div>
                <SettingRow label={t('settings.verbose')} description={t('settings.verboseDesc')}>
                  <Toggle
                    checked={settings.verbose}
                    onChange={v => setSettings(s => ({ ...s, verbose: v }))}
                  />
                </SettingRow>
                <SettingRow label={t('settings.showToken')} description={t('settings.showTokenDesc')}>
                  <Toggle
                    checked={settings.showToken}
                    onChange={v => setSettings(s => ({ ...s, showToken: v }))}
                  />
                </SettingRow>
              </div>
            )}

          </div>
        </div>

        {/* Footer actions */}
        <div className="flex gap-2 justify-end px-5 py-3.5 border-t border-line-soft bg-sunken/60 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] border border-line rounded-lg text-ink-soft hover:bg-sunken transition-colors"
          >
            {t('settings.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-[13px] bg-accent-strong text-white rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
          >
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>

      </div>
    </div>
  )
}
