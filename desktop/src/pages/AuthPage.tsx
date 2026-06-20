import { useState } from 'react'
import type {
  AuthResult,
  DeviceCodeInfo,
  ProviderAuthInput,
  ProviderAuthTypeInput,
  ProviderType,
  QuickProviderName
} from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import Header from '../components/Header'

interface AuthPageProps {
  onBack?: () => void
  onSuccess: (result: AuthResult) => void
}

type AuthView = 'default' | 'oauth-pending' | 'token-input' | 'provider-input' | 'codex-pending'
type ProviderChoice = QuickProviderName | 'custom'

const PROVIDER_TYPES: ProviderType[] = ['anthropic', 'openai-compatible', 'openai-responses']
const PROVIDER_AUTH_TYPES: ProviderAuthTypeInput[] = ['__default__', 'x-api-key', 'authorization']
const QUICK_PROVIDER_DEFAULTS: Record<QuickProviderName, { baseUrl: string; editableType: boolean; type: ProviderType }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    editableType: true,
    type: 'openai-compatible'
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    editableType: true,
    type: 'openai-compatible'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    editableType: false,
    type: 'anthropic'
  }
}

export default function AuthPage({ onBack, onSuccess }: AuthPageProps) {
  const { t } = useLanguage()
  const [view, setView] = useState<AuthView>('default')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>('deepseek')
  const [providerName, setProviderName] = useState('')
  const [providerType, setProviderType] = useState<ProviderType>('openai-compatible')
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerAuthType, setProviderAuthType] = useState<ProviderAuthTypeInput>('__default__')
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)

  const completeAuth = (result: AuthResult, fallbackError: string) => {
    if (result.success) {
      onSuccess(result)
      return
    }

    setError(result.error ?? fallbackError)
  }

  const handleOAuth = async () => {
    setLoading(true)
    setError('')
    try {
      const code = await window.electronAPI.getDeviceCode()
      setDeviceCode(code)
      setView('oauth-pending')
      setPolling(true)

      const unsubscribe = window.electronAPI.onAuthSuccess((result) => {
        unsubscribe()
        setPolling(false)
        completeAuth(result, t('auth.authFailed'))
        if (!result.success) setView('default')
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDeviceUrl = () => {
    if (deviceCode) window.electronAPI.openUrl(deviceCode.verification_uri)
  }

  const handleCopyCode = () => {
    if (!deviceCode) return
    navigator.clipboard.writeText(deviceCode.user_code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.saveToken(tokenInput.trim())
      completeAuth(result, t('auth.tokenInvalid'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    setView('default')
    setDeviceCode(null)
    setError('')
    setPolling(false)
    setTokenInput('')
    setProviderApiKey('')
    setProviderAuthType('__default__')
  }

  const handleProviderSelect = (provider: ProviderChoice) => {
    setProviderChoice(provider)
    setProviderApiKey('')
    setProviderAuthType('__default__')
    setError('')

    if (provider === 'custom') {
      setProviderName('')
      setProviderType('openai-compatible')
      setProviderBaseUrl('')
    } else {
      const defaults = QUICK_PROVIDER_DEFAULTS[provider]
      setProviderName(provider)
      setProviderType(defaults.type)
      setProviderBaseUrl(defaults.baseUrl)
    }

    setView('provider-input')
  }

  const handleSaveProvider = async () => {
    setLoading(true)
    setError('')

    try {
      const input: ProviderAuthInput = providerChoice === 'custom'
        ? {
            provider: 'custom',
            name: providerName.trim(),
            type: providerType,
            baseUrl: providerBaseUrl.trim(),
            apiKey: providerApiKey.trim(),
            authType: providerAuthType
          }
        : {
            provider: providerChoice,
            type: providerType,
            baseUrl: providerBaseUrl.trim(),
            apiKey: providerApiKey.trim()
          }
      const result = await window.electronAPI.configureProvider(input)
      completeAuth(result, t('auth.providerInvalid'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleCodexOAuth = async () => {
    setView('codex-pending')
    setLoading(true)
    setError('')

    try {
      const result = await window.electronAPI.startCodexLogin()
      completeAuth(result, t('auth.authFailed'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const getQuickProviderLabel = (provider: QuickProviderName): string => {
    switch (provider) {
      case 'deepseek':
        return t('auth.providerDeepseek')
      case 'dashscope':
        return t('auth.providerDashscope')
      case 'openrouter':
        return t('auth.providerOpenrouter')
    }
  }

  const selectedQuickProvider = providerChoice === 'custom' ? null : QUICK_PROVIDER_DEFAULTS[providerChoice]
  const selectedProviderLabel = providerChoice === 'custom'
    ? t('auth.customProvider')
    : getQuickProviderLabel(providerChoice)
  const canEditProviderType = providerChoice === 'custom' || selectedQuickProvider?.editableType

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      <Header />

      {onBack && (
        <div className="px-4 pt-3 shrink-0">
          <button
            onClick={onBack}
            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[13px] font-medium text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-700"
          >
            {t('auth.backToHome')}
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-6 gap-5">
        {/* Logo and title */}
        <div className="text-center">
          <div className="w-14 h-14 bg-[#0f172a] rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-[0_10px_26px_rgba(15,23,42,0.18)]">
            <span className="text-white text-base font-extrabold">CA</span>
          </div>
          <h1 className="text-lg font-bold text-[#0f172a]">Copilot API</h1>
          <p className="text-[13px] text-slate-500 mt-1">{t('auth.subtitle')}</p>
        </div>

        {/* Default state: provider choices */}
        {view === 'default' && (
          <div className="grid w-full max-w-[360px] grid-cols-2 gap-2 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <button
              onClick={handleOAuth}
              disabled={loading}
              className="col-span-2 w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg flex items-center justify-center gap-2 hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
              </svg>
              {loading ? t('auth.loading') : t('auth.githubAuth')}
            </button>
            <button
              onClick={handleCodexOAuth}
              disabled={loading}
              className="col-span-2 w-full py-2.5 bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {t('auth.codexAuth')}
            </button>
            {(['deepseek', 'dashscope', 'openrouter'] as QuickProviderName[]).map(provider => (
              <button
                key={provider}
                onClick={() => handleProviderSelect(provider)}
                className="w-full py-2.5 bg-white border border-slate-200 text-slate-600 text-[13px] rounded-lg hover:bg-slate-50 transition-colors"
              >
                {getQuickProviderLabel(provider)}
              </button>
            ))}
            <button
              onClick={() => handleProviderSelect('custom')}
              className="w-full py-2.5 bg-white border border-slate-200 text-slate-600 text-[13px] rounded-lg hover:bg-slate-50 transition-colors"
            >
              {t('auth.customProvider')}
            </button>
            <button
              onClick={() => setView('token-input')}
              className="col-span-2 w-full py-2 text-[13px] text-slate-400 hover:text-slate-600 transition-colors"
            >
              {t('auth.manualToken')}
            </button>
          </div>
        )}

        {/* OAuth pending state */}
        {view === 'oauth-pending' && deviceCode && (
          <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <div>
              <p className="text-[13px] text-slate-400 mb-1.5">{t('auth.deviceCode')}</p>
              <div className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-slate-300 rounded-lg bg-slate-50">
                <span className="font-mono text-[13px] font-bold text-[#0f172a] tracking-widest flex-1">
                  {deviceCode.user_code}
                </span>
                <button
                  onClick={handleCopyCode}
                  className="text-[13px] text-blue-500 hover:text-blue-600 shrink-0"
                >
                  {copied ? t('auth.copied') : t('auth.copy')}
                </button>
              </div>
            </div>
            <div>
              <p className="text-[13px] text-slate-400 mb-1.5">{t('auth.deviceCodeUrl')}</p>
              <button
                onClick={handleOpenDeviceUrl}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg bg-white text-left text-[13px] text-blue-500 hover:text-blue-600 hover:bg-slate-50 transition-colors break-all"
              >
                {deviceCode.verification_uri}
              </button>
            </div>
            <button
              onClick={handleOpenDeviceUrl}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 transition-colors"
            >
              {t('auth.openAuthPage')}
            </button>
            {polling && (
              <p className="text-center text-[13px] text-slate-400 animate-pulse">
                {t('auth.waitingAuth')}
              </p>
            )}
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {/* Expanded token input state */}
        {view === 'token-input' && (
          <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <textarea
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="gho_xxxxxxxxxxxxxxxx"
              rows={3}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-slate-300 font-mono"
            />
            <button
              onClick={handleSaveToken}
              disabled={loading || !tokenInput.trim()}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? t('auth.verifying') : t('auth.confirmAdd')}
            </button>
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {view === 'provider-input' && (
          <div className="w-full max-w-[360px] flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <div className="text-center text-[13px] font-semibold text-[#0f172a]">
              {selectedProviderLabel}
            </div>

            {providerChoice === 'custom' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-slate-400">{t('auth.providerName')}</span>
                <input
                  value={providerName}
                  onChange={e => setProviderName(e.target.value)}
                  placeholder="dashscope"
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-300"
                />
              </label>
            )}

            {canEditProviderType && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-slate-400">{t('auth.providerType')}</span>
                <select
                  value={providerType}
                  onChange={e => setProviderType(e.target.value as ProviderType)}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg bg-white text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-300"
                >
                  {PROVIDER_TYPES.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-slate-400">{t('auth.providerBaseUrl')}</span>
              <input
                value={providerBaseUrl}
                onChange={e => setProviderBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-300"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-slate-400">{t('auth.providerApiKey')}</span>
              <textarea
                value={providerApiKey}
                onChange={e => setProviderApiKey(e.target.value)}
                placeholder="sk-..."
                rows={3}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-slate-300 font-mono"
              />
            </label>

            {providerChoice === 'custom' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-slate-400">{t('auth.providerAuthType')}</span>
                <select
                  value={providerAuthType}
                  onChange={e => setProviderAuthType(e.target.value as ProviderAuthTypeInput)}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg bg-white text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-300"
                >
                  {PROVIDER_AUTH_TYPES.map(authType => (
                    <option key={authType} value={authType}>
                      {authType === '__default__' ? t('auth.providerAuthTypeDefault') : authType}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button
              onClick={handleSaveProvider}
              disabled={loading || !providerApiKey.trim()}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? t('auth.verifying') : t('auth.confirmAdd')}
            </button>
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {view === 'codex-pending' && (
          <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
            <p className="text-center text-[13px] text-slate-400 animate-pulse">
              {loading ? t('auth.waitingCodexAuth') : t('auth.codexCallbackRequired')}
            </p>
            <button
              onClick={handleCodexOAuth}
              disabled={loading}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? t('auth.verifying') : t('auth.confirmAdd')}
            </button>
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="w-full max-w-[240px] px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[13px] text-red-600 flex items-center gap-1.5">
            <span>⚠️</span><span>{error}</span>
          </div>
        )}

        <p className="text-[13px] text-slate-200">{t('auth.loginConsent')}</p>
      </div>
    </div>
  )
}
