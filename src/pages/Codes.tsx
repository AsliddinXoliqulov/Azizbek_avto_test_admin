import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PageHeader } from '../App'
import { useConfirm } from '../components/ConfirmProvider'
import { Modal } from '../components/Modal'
import { Notice } from '../components/Notice'
import { requireSupabase } from '../lib/supabase'
import { useSiteLanguage } from '../lib/siteLanguage'
import type { ActivationToken } from '../lib/types'
import { getErrorMessage } from '../lib/types'

interface PublishRun {
  status: string
  conclusion: string | null
  url: string
  createdAt: number
}

interface PublishPreviewItem {
  action: 'added' | 'updated' | 'deleted'
  label: string
}

interface PublishPreviewGroup {
  title: string
  added: number
  updated: number
  deleted: number
  total: number
  items: PublishPreviewItem[]
  omitted: number
}

interface PublishPreview {
  currentVersion: string | null
  snapshotVersion: string
  fullUploadRequired: boolean
  hasChanges: boolean
  totalChanges: number
  uploadBytes: number
  imageUploadBytes: number
  changes: PublishPreviewGroup[]
  imageChanges: { added: number; updated: number; deleted: number }
  warningCount: number
}

function isPublishPreviewItem(value: unknown): value is PublishPreviewItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    (item.action === 'added' || item.action === 'updated' || item.action === 'deleted') &&
    typeof item.label === 'string'
  )
}

function isPublishPreviewGroup(value: unknown): value is PublishPreviewGroup {
  if (!value || typeof value !== 'object') return false
  const group = value as Record<string, unknown>
  return (
    typeof group.title === 'string' &&
    ['added', 'updated', 'deleted', 'total', 'omitted'].every(
      (key) => Number.isSafeInteger(group[key]) && Number(group[key]) >= 0
    ) &&
    Array.isArray(group.items) &&
    group.items.every(isPublishPreviewItem)
  )
}

function isPublishPreview(value: unknown): value is PublishPreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as Record<string, unknown>
  const imageChanges = preview.imageChanges
  return (
    (preview.currentVersion === null || typeof preview.currentVersion === 'string') &&
    typeof preview.snapshotVersion === 'string' &&
    typeof preview.fullUploadRequired === 'boolean' &&
    typeof preview.hasChanges === 'boolean' &&
    Number.isSafeInteger(preview.totalChanges) &&
    Number(preview.totalChanges) >= 0 &&
    Number.isSafeInteger(preview.uploadBytes) &&
    Number(preview.uploadBytes) >= 0 &&
    Number.isSafeInteger(preview.imageUploadBytes) &&
    Number(preview.imageUploadBytes) >= 0 &&
    Number.isSafeInteger(preview.warningCount) &&
    Number(preview.warningCount) >= 0 &&
    Array.isArray(preview.changes) &&
    preview.changes.every(isPublishPreviewGroup) &&
    Boolean(imageChanges) &&
    typeof imageChanges === 'object' &&
    ['added', 'updated', 'deleted'].every(
      (key) =>
        Number.isSafeInteger((imageChanges as Record<string, unknown>)[key]) &&
        Number((imageChanges as Record<string, unknown>)[key]) >= 0
    )
  )
}

const isRunActive = (run: PublishRun | null) =>
  run !== null && ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)

export default function Codes() {
  const confirm = useConfirm()
  const { t, language } = useSiteLanguage()

  const [tokens, setTokens] = useState<ActivationToken[]>([])
  const [platform, setPlatform] = useState<'desktop' | 'website'>('desktop')
  const [filter, setFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [publishPreview, setPublishPreview] = useState<PublishPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [pendingChanges, setPendingChanges] = useState<number | null>(null)
  const [publishRun, setPublishRun] = useState<PublishRun | null>(null)
  const wasRunActive = useRef(false)
  const dispatchedAt = useRef(0)
  const [pendingStatusError, setPendingStatusError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null)
  const [resettingTokenId, setResettingTokenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const client = requireSupabase()
      const website = platform === 'website'
      const { error: expireError } = await client.rpc(
        website ? 'expire_stale_web_activation_tokens' : 'expire_stale_tokens',
      )
      if (expireError) throw expireError
      let request = website
        ? client.from('web_activation_tokens')
          .select('id,code,note,status,created_at,expires_at,device_id,allowed_device_id,activated_at,created_by')
          .order('created_at', { ascending: false })
          .limit(200)
        : client.from('activation_tokens')
          .select('id,code,note,status,created_at,expires_at,device_id,activated_at,created_by')
          .order('created_at', { ascending: false })
          .limit(200)
      if (filter) request = request.eq('status', filter)
      const { data, error: tokenError } = await request
      if (tokenError) throw tokenError
      setTokens((data || []) as ActivationToken[])
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [filter, platform])

  useEffect(() => { void load() }, [load])

  const loadPublishStatus = useCallback(async () => {
    try {
      const { data, error: sessionError } = await requireSupabase().auth.getSession()
      if (sessionError) throw sessionError
      const accessToken = data.session?.access_token
      if (!accessToken) throw new Error('Admin sessiyasi topilmadi.')

      const response = await fetch('/api/static-site-publish-status', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : 'Kutilayotgan o‘zgarishlar sonini olib bo‘lmadi.'
        )
      }
      if (!Number.isSafeInteger(result.pendingChanges) || result.pendingChanges < 0) {
        throw new Error('Nashr holati noto‘g‘ri javob qaytardi.')
      }
      setPendingChanges(result.pendingChanges)
      const nextRun: PublishRun | null =
        result.run && typeof result.run.status === 'string'
          ? {
              status: result.run.status,
              conclusion: typeof result.run.conclusion === 'string' ? result.run.conclusion : null,
              url: typeof result.run.url === 'string' ? result.run.url : '',
              createdAt: Date.parse(result.run.createdAt) || 0,
            }
          : null
      // Tugma bosilgandan keyin GitHub yangi ishni yaratguncha oldingi (eski) ish natijasi ko'rsatilmaydi.
      const waitingSince = dispatchedAt.current
      const isStale =
        waitingSince > 0 &&
        Date.now() - waitingSince < 90_000 &&
        (!nextRun || nextRun.createdAt < waitingSince - 30_000)
      if (!isStale) {
        if (nextRun && nextRun.createdAt >= waitingSince - 30_000) dispatchedAt.current = 0
        setPublishRun(nextRun)
      }
      setPendingStatusError('')
    } catch (reason) {
      setPendingChanges(null)
      setPendingStatusError(getErrorMessage(reason))
    }
  }, [])

  const runActive = isRunActive(publishRun)
  const compareDisabled =
    publishing || previewLoading || runActive

  // Nashr ishlayotganida holatni tez-tez (5 s), aks holda kamdan-kam (30 s) tekshiramiz.
  useEffect(() => {
    void loadPublishStatus()
    const timer = window.setInterval(
      () => void loadPublishStatus(),
      runActive ? 5_000 : 30_000
    )
    return () => window.clearInterval(timer)
  }, [loadPublishStatus, runActive])

  // GitHub Action tugaganda natijani adminga ko'rsatamiz.
  useEffect(() => {
    if (wasRunActive.current && !runActive && publishRun) {
      if (publishRun.conclusion === 'success') {
        setError('')
        setSuccess(t('Nashr tugadi. Vercel saytni 1–2 daqiqada yangilaydi.'))
      } else {
        setSuccess('')
        setError(
          `${t('Nashr xato bilan tugadi.')} ${publishRun.url ? `GitHub Actions: ${publishRun.url}` : ''}`.trim()
        )
      }
    }
    wasRunActive.current = runActive
  }, [runActive, publishRun, t])

  function closePublishPreview() {
    if (publishing) return
    setShowPreview(false)
    setPublishPreview(null)
    setPreviewError('')
  }

  async function compareWebsiteData() {
    if (compareDisabled) return
    setShowPreview(true)
    setPreviewLoading(true)
    setPublishPreview(null)
    setPreviewError('')
    setError('')
    setSuccess('')
    try {
      const { data, error: sessionError } = await requireSupabase().auth.getSession()
      if (sessionError) throw sessionError
      const accessToken = data.session?.access_token
      if (!accessToken) throw new Error(t('Admin sessiyasi topilmadi.'))

      const response = await fetch('/api/static-site-publish-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : t('GitHub va Supabase ma’lumotlarini taqqoslab bo‘lmadi.')
        )
      }
      if (!isPublishPreview(result)) {
        throw new Error(t('Taqqoslash xizmati noto‘g‘ri javob qaytardi.'))
      }
      setPublishPreview(result)
    } catch (reason) {
      setPreviewError(getErrorMessage(reason))
    } finally {
      setPreviewLoading(false)
    }
  }

  function submitPublishPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!publishPreview?.hasChanges || publishing || previewLoading) return
    void publishWebsiteData(publishPreview.snapshotVersion)
  }

  async function publishWebsiteData(expectedVersion: string) {
    if (publishing || runActive) return
    setPublishing(true)
    setError('')
    setSuccess('')
    try {
      const { data, error: sessionError } = await requireSupabase().auth.getSession()
      if (sessionError) throw sessionError
      const accessToken = data.session?.access_token
      if (!accessToken) throw new Error(t('Admin sessiyasi topilmadi.'))

      const response = await fetch('/api/publish-static-site', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : t('Sayt ma’lumotlarini nashr qilib bo‘lmadi.')
        )
      }
      setSuccess(
        typeof result.message === 'string'
          ? result.message
          : t('Sayt ma’lumotlarini nashr qilish boshlandi.')
      )
      wasRunActive.current = true
      dispatchedAt.current = Date.now()
      setPublishRun({ status: 'queued', conclusion: null, url: '', createdAt: Date.now() })
      setShowPreview(false)
      setPublishPreview(null)
      window.setTimeout(() => void loadPublishStatus(), 4_000)
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setPublishing(false)
    }
  }

  const selectedTokens = tokens.filter((token) => selectedIds.has(token.id))
  const revocableTokens = selectedTokens.filter((token) => ['PENDING', 'ACTIVATED'].includes(token.status))
  const revokedTokens = selectedTokens.filter((token) => token.status === 'REVOKED')

  function toggleToken(tokenId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(tokenId)
      else next.delete(tokenId)
      return next
    })
  }

  function toggleAllTokens(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const token of tokens) {
        if (checked) next.add(token.id)
        else next.delete(token.id)
      }
      return next
    })
  }

  async function bulkAction(action: 'revoke' | 'reactivate' | 'delete') {
    const targets = action === 'revoke' ? revocableTokens : revokedTokens
    if (!targets.length || bulkBusy) return

    const actionLabel = action === 'revoke'
      ? t('Bekor qilish')
      : action === 'reactivate'
        ? t('Qayta faollashtirish')
        : t('Butunlay o‘chirish')
    const confirmed = await confirm({
      title: actionLabel,
      message: t('Tanlangan {0} ta kod uchun “{1}” amalini bajarasizmi?')
        .replace('{0}', String(targets.length))
        .replace('{1}', actionLabel),
      confirmLabel: actionLabel,
      danger: action !== 'reactivate',
    })
    if (!confirmed) return

    setBulkBusy(true)
    setError('')
    setSuccess('')
    let completed = 0
    const failures: string[] = []
    const rpcName = action === 'revoke'
      ? platform === 'website' ? 'revoke_web_activation_code' : 'revoke_activation_code'
      : action === 'reactivate'
        ? platform === 'website' ? 'reactivate_revoked_web_activation_code' : 'reactivate_revoked_activation_code'
        : platform === 'website' ? 'delete_revoked_web_activation_code' : 'delete_revoked_activation_code'

    try {
      const client = requireSupabase()
      for (const token of targets) {
        const { error: rpcError } = await client.rpc(rpcName, { p_id: token.id })
        if (rpcError) failures.push(`${token.code}: ${getErrorMessage(rpcError)}`)
        else completed += 1
      }
      setSelectedIds(new Set())
      await load()
      if (completed) {
        setSuccess(t('{0} ta kodga “{1}” amali bajarildi.').replace('{0}', String(completed)).replace('{1}', actionLabel))
      }
      if (failures.length) {
        setError(t('{0} ta kodni o‘zgartirib bo‘lmadi: {1}')
          .replace('{0}', String(failures.length))
          .replace('{1}', failures.join('; ')))
      }
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setBulkBusy(false)
    }
  }

  async function copyCode(token: ActivationToken) {
    try {
      await navigator.clipboard.writeText(token.code)
      setCopiedTokenId(token.id)
      setSuccess(t('{0} kodi nusxalandi.').replace('{0}', token.code))
    } catch (reason) {
      setError(t('Kodni nusxalab bo‘lmadi: {0}').replace('{0}', getErrorMessage(reason)))
    }
  }

  async function revoke(token: ActivationToken) {
    const confirmed = await confirm({
      title: t('Aktivatsiya kodini bekor qilish'),
      message: platform === 'website'
        ? t('{0} kodini bekor qilasizmi? Bu kod bilan faollashtirilgan barcha qurilmalar bloklanadi.').replace('{0}', token.code)
        : t('{0} kodini bekor qilasizmi? Ulangan qurilma keyingi tekshiruvda bloklanadi.').replace('{0}', token.code),
      confirmLabel: t('Bekor qilish'),
      danger: true,
    })
    if (!confirmed) return
    try {
      const { error: revokeError } = await requireSupabase().rpc(
        platform === 'website' ? 'revoke_web_activation_code' : 'revoke_activation_code',
        { p_id: token.id },
      )
      if (revokeError) throw revokeError
      setSuccess(t('{0} kodi bekor qilindi.').replace('{0}', token.code))
      await load()
    } catch (reason) {
      setError(getErrorMessage(reason))
    }
  }

  async function reactivate(token: ActivationToken) {
    const confirmed = await confirm({
      title: t('Kodni qayta faollashtirish'),
      message: platform === 'website'
        ? t('{0} kodini qayta faollashtirasizmi? U 15 kun davomida istalgan qurilmada ishlaydi.')
          .replace('{0}', token.code)
        : token.device_id
          ? t('{0} kodini qayta faollashtirasizmi? Kod {1} davomida ochiladi va faqat avval ulangan qurilmada ishlaydi ({2}…).')
            .replace('{0}', token.code)
            .replace('{1}', t('1 soat'))
            .replace('{2}', token.device_id.slice(0, 10))
          : t('{0} kodini qayta faollashtirasizmi? Kod {1} davomida ochiladi; bu kod avval qurilmaga ulanmagan.')
            .replace('{0}', token.code)
            .replace('{1}', t('1 soat')),
      confirmLabel: t('Qayta faollashtirish'),
    })
    if (!confirmed) return
    try {
      const { error: rpcError } = await requireSupabase().rpc(
        platform === 'website' ? 'reactivate_revoked_web_activation_code' : 'reactivate_revoked_activation_code',
        { p_id: token.id },
      )
      if (rpcError) throw rpcError
      setSuccess(t('{0} kodi qayta faollashtirildi.').replace('{0}', token.code))
      await load()
    } catch (reason) {
      setError(getErrorMessage(reason))
    }
  }

  async function deleteInactive(token: ActivationToken) {
    const confirmed = await confirm({
      title: t('Kodni bazadan butunlay o‘chirish'),
      message: t('{0} kodi va unga tegishli yozuv bazadan butunlay o‘chadi. Bu amalni qaytarib bo‘lmaydi.').replace('{0}', token.code),
      confirmLabel: t('Butunlay o‘chirish'),
      danger: true,
    })
    if (!confirmed) return
    try {
      const { error: rpcError } = await requireSupabase().rpc(
        platform === 'website' ? 'delete_revoked_web_activation_code' : 'delete_revoked_activation_code',
        { p_id: token.id },
      )
      if (rpcError) throw rpcError
      setSuccess(t('{0} kodi bazadan butunlay o‘chirildi.').replace('{0}', token.code))
      await load()
    } catch (reason) {
      setError(getErrorMessage(reason))
    }
  }

  async function resetDevice(token: ActivationToken) {
    const confirmed = await confirm({
      title: t('Qurilmani tiklash'),
      message: t('{0} kodi qurilma bog‘lanishini yo‘qotadi va keyingi kirishda boshqa qurilmaga bog‘lanadi.')
        .replace('{0}', token.code),
      confirmLabel: t('Qurilmani tiklash'),
      danger: true,
    })
    if (!confirmed) return
    setResettingTokenId(token.id)
    setError('')
    try {
      const { error: rpcError } = await requireSupabase().rpc('reset_activation_device', {
        p_id: token.id,
      })
      if (rpcError) throw rpcError
      setSuccess(t('{0} kodi uchun qurilma bog‘lanishi tiklandi.').replace('{0}', token.code))
      await load()
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setResettingTokenId(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Aktivatsiya kodlari"
        description="Desktop ilova va sayt uchun alohida aktivatsiya kodlarini yarating va boshqaring."
        action={
          <div className="page-action-group activation-code-actions">
            <button
              className="button button-primary"
              onClick={() => setShowCreate(true)}
            >
              {t('＋ Kod yaratish')}
            </button>
            <div className="publish-button-wrap">
              {pendingChanges !== null && pendingChanges > 0 && (
                <span
                  className="publish-pending-count"
                  title={`${pendingChanges.toLocaleString(language)} ta o‘zgarish hali nashr qilinmagan`}
                  aria-label={`${pendingChanges.toLocaleString(language)} ta o‘zgarish hali nashr qilinmagan`}
                  aria-live="polite"
                >
                  {pendingChanges.toLocaleString(language)}
                </span>
              )}
              <button
                type="button"
                className={`button button-quiet publish-icon-button${publishing || previewLoading || runActive ? ' is-publishing' : ''}`}
                onClick={() => void compareWebsiteData()}
                disabled={compareDisabled}
                aria-busy={publishing || previewLoading || runActive}
                aria-label={t(publishing || runActive ? 'Nashr jarayoni bajarilmoqda' : previewLoading ? 'Sayt ma’lumotlari solishtirilmoqda' : 'GitHub va Supabase ma’lumotlarini solishtirish')}
                title={t(publishing || runActive ? 'Nashr jarayoni bajarilmoqda' : previewLoading ? 'Sayt ma’lumotlari solishtirilmoqda' : 'GitHub va Supabase ma’lumotlarini solishtirish')}
              >
                {publishing || previewLoading || runActive ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                  </svg>
                ) : (
                  <wa-icon name="share-nodes" aria-hidden="true"></wa-icon>
                )}
                <span>{t(publishing || runActive ? 'Nashr…' : previewLoading ? 'Solishtirilmoqda…' : 'Solishtirish')}</span>
              </button>
            </div>
          </div>
        }
      />
      {error && <Notice message={error} onClose={() => setError('')} />}
      {pendingStatusError && (
        <Notice
          message={pendingStatusError}
          onClose={() => setPendingStatusError('')}
        />
      )}
      {success && <Notice message={success} kind="success" onClose={() => setSuccess('')} />}
      {showPreview && (
        <Modal
          title="Sayt ma’lumotlarini solishtirish"
          onClose={closePublishPreview}
          onSubmit={submitPublishPreview}
          busy={publishing}
          submitLabel="Yuklash"
          submitDisabled={previewLoading || !publishPreview?.hasChanges}
          className="publish-preview-modal"
        >
          {previewLoading && (
            <div className="publish-preview-loading" role="status" aria-live="polite">
              <span className="publish-preview-spinner" aria-hidden="true" />
              <span>{t('GitHub va Supabase ma’lumotlari solishtirilmoqda…')}</span>
            </div>
          )}
          {previewError && (
            <div className="publish-preview-error">
              <Notice message={previewError} />
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void compareWebsiteData()}
                disabled={previewLoading}
              >
                {t('Qayta solishtirish')}
              </button>
            </div>
          )}
          {publishPreview && (
            <PublishPreviewContent preview={publishPreview} language={language} />
          )}
        </Modal>
      )}
      <section className="panel-card table-panel">
        <div className="filter-bar">
          <div className="filter-tabs">
            <button className={platform === 'desktop' ? 'selected' : ''} onClick={() => { setPlatform('desktop'); setFilter(''); setSelectedIds(new Set()) }}>{t('Desktop ilova')}</button>
            <button className={platform === 'website' ? 'selected' : ''} onClick={() => { setPlatform('website'); setFilter(''); setSelectedIds(new Set()) }}>{t('Sayt')}</button>
          </div>
          <select
            className="filter-select"
            aria-label={t('Aktivatsiya kodlarini filtrlash')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value); setSelectedIds(new Set()) }}
          >
            <option value="">{t('Barchasi')}</option>
            <option value="ACTIVATED">{statusLabel('ACTIVATED', t)}</option>
            <option value="REVOKED">{statusLabel('REVOKED', t)}</option>
          </select>
          {selectedTokens.length > 0 && (
            <details className="bulk-code-menu">
              <summary aria-label={t('Tanlangan kodlar amallari')} title={t('Amallar')}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="4" r="1.5" />
                  <circle cx="10" cy="10" r="1.5" />
                  <circle cx="10" cy="16" r="1.5" />
                </svg>
              </summary>
              <div className="bulk-code-menu-options">
                {revocableTokens.length > 0 && (
                  <button className="danger-text" disabled={bulkBusy} onClick={() => void bulkAction('revoke')}>
                    {t('Bekor qilish')} ({revocableTokens.length})
                  </button>
                )}
                {revokedTokens.length > 0 && (
                  <>
                    <button disabled={bulkBusy} onClick={() => void bulkAction('reactivate')}>
                      {t('Qayta faollashtirish')} ({revokedTokens.length})
                    </button>
                    <button className="danger-text" disabled={bulkBusy} onClick={() => void bulkAction('delete')}>
                      {t('Butunlay o‘chirish')} ({revokedTokens.length})
                    </button>
                  </>
                )}
              </div>
            </details>
          )}
        </div>
        <div className="table-scroll"><table><thead><tr>
          <th><input type="checkbox" aria-label={t('Barcha kodlarni tanlash')} checked={tokens.length > 0 && tokens.every((token) => selectedIds.has(token.id))} onChange={(event) => toggleAllTokens(event.target.checked)} /></th>
          <th>{t('KOD / IZOH')}</th><th>{t('HOLATI')}</th><th>{t('YARATILGAN')}</th><th>{t('MUDDATI')}</th><th>{t('QURILMA')}</th><th className="align-right">{t('AMALLAR')}</th></tr></thead><tbody>
          {loading ? <tr><td className="table-state" colSpan={7}>{t('Kodlar yuklanmoqda…')}</td></tr>
            : tokens.length === 0 ? <tr><td className="table-state" colSpan={7}>{t('Kodlar topilmadi.')}</td></tr>
              : tokens.map((token) => <tr key={token.id}>
                <td><input type="checkbox" aria-label={t('{0} kodini tanlash').replace('{0}', token.code)} checked={selectedIds.has(token.id)} onChange={(event) => toggleToken(token.id, event.target.checked)} /></td>
                <td><div className="token-cell"><div className="token-code"><code>{token.code}</code><button className="icon-button" type="button" onClick={() => void copyCode(token)} title={t(copiedTokenId === token.id ? 'Nusxalandi' : 'Kodni nusxalash')} aria-label={t('{0} kodini nusxalash').replace('{0}', token.code)}>{copiedTokenId === token.id ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" /></svg> : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2.5" width="8" height="10" rx="1.5" /><path d="M10.5 13.5v.2a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 13.7V6.3A1.3 1.3 0 0 1 3.3 5h.2" /></svg>}</button></div><small>{token.note || t('Izoh kiritilmagan')}</small></div></td>
                <td><span className={`badge ${token.status === 'ACTIVATED' ? 'badge-success' : token.status === 'PENDING' ? 'badge-warning' : 'badge-neutral'}`}><i />{statusLabel(token.status, t)}</span></td>
                <td>{formatDate(token.created_at, language)}</td><td>{formatDate(token.expires_at, language)}</td>
                <td><span className="device-id">{platform === 'website'
                  ? token.status === 'ACTIVATED' ? t('Ko‘p qurilmada ishlaydi') : '—'
                  : token.device_id ? `${token.device_id.slice(0, 10)}…` : '—'}</span></td>
                <td><div className="row-actions">
                  {platform === 'desktop' && token.device_id && (
                    <button
                      className="text-button"
                      disabled={resettingTokenId === token.id}
                      onClick={() => void resetDevice(token)}
                    >
                      {t(resettingTokenId === token.id ? 'Tiklanmoqda…' : 'Qurilmani tiklash')}
                    </button>
                  )}
                  {token.status === 'REVOKED' && (
                    <button className="text-button" onClick={() => void reactivate(token)}>{t('Qayta faollashtirish')}</button>
                  )}
                  {token.status === 'REVOKED'
                    ? <button
                      className="icon-button danger-icon"
                      type="button"
                      title={t('Aktivatsiya kodini butunlay o‘chirish')}
                      aria-label={t('{0} kodini butunlay o‘chirish').replace('{0}', token.code)}
                      onClick={() => void deleteInactive(token)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6" /></svg>
                    </button>
                    : ['PENDING', 'ACTIVATED'].includes(token.status) && (
                      <button className="text-button danger-text" onClick={() => void revoke(token)}>{t('Bekor qilish')}</button>
                    )}
                </div></td>
              </tr>)}
        </tbody></table></div>
        <div className="table-footer"><span>{t('Oxirgi 200 tagacha kod ko‘rsatiladi')}</span></div>
      </section>
      {showCreate && <CreateCode platform={platform} onClose={() => setShowCreate(false)} onCreated={(code) => { setShowCreate(false); setSuccess(t('Yangi aktivatsiya kodi: {0}').replace('{0}', code)); void load() }} />}
    </>
  )
}

function PublishPreviewContent({
  preview,
  language,
}: {
  preview: PublishPreview
  language: string
}) {
  const { t } = useSiteLanguage()
  const imageChangeCount =
    preview.imageChanges.added + preview.imageChanges.updated + preview.imageChanges.deleted
  const megabytes = preview.uploadBytes / (1024 * 1024)
  const imageMegabytes = preview.imageUploadBytes / (1024 * 1024)
  const formattedMegabytes = megabytes.toLocaleString(
    language === 'ru' ? 'ru-RU' : 'uz-UZ',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  )
  const formattedImageMegabytes = imageMegabytes.toLocaleString(
    language === 'ru' ? 'ru-RU' : 'uz-UZ',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  )

  return (
    <div className="publish-preview-content">
      <div className="publish-preview-stats">
        <div>
          <strong>{preview.totalChanges.toLocaleString(language)}</strong>
          <span>{t('Farq')}</span>
        </div>
        <div>
          <strong>{formattedMegabytes} MB</strong>
          <span>
            {preview.fullUploadRequired
              ? t('To‘liq baza — bir martalik')
              : t('Faqat o‘zgarishlar')}
          </span>
        </div>
        <div>
          <strong>{imageChangeCount.toLocaleString(language)}</strong>
          <span>{t('Rasm havolasi farqi')}</span>
        </div>
      </div>
      <p className="publish-preview-note">
        {t('Birinchi nashr to‘liq baza, keyingi nashrlar faqat o‘zgarishlar bo‘ladi. Umumiy hajm snapshot/delta va yangi rasm fayllarini o‘z ichiga oladi.')}
        {' '}
        {t('Repoga qo‘shiladigan yangi rasm fayllari: {0} MB').replace(
          '{0}',
          formattedImageMegabytes
        )}
      </p>
      {!preview.hasChanges ? (
        <p className="publish-preview-empty">{t('GitHub bilan farq topilmadi. Yuklanadigan o‘zgarish yo‘q.')}</p>
      ) : (
        <div className="publish-preview-groups">
          {preview.changes.map((group) => (
            <section className="publish-preview-group" key={group.title}>
              <div className="publish-preview-group-heading">
                <h3>{t(group.title)}</h3>
                <span>
                  +{group.added.toLocaleString(language)} ·
                  {' '}{t('o‘zgardi')} {group.updated.toLocaleString(language)} ·
                  {' '}{t('o‘chirildi')} {group.deleted.toLocaleString(language)}
                </span>
              </div>
              {group.items.length > 0 && (
                <ul>
                  {group.items.map((item, index) => (
                    <li key={`${group.title}-${item.action}-${index}`}>
                      <span className={`publish-preview-action is-${item.action}`}>
                        {t(item.action === 'added' ? 'Yangi' : item.action === 'deleted' ? 'O‘chirildi' : 'O‘zgardi')}
                      </span>
                      <span>{item.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {group.omitted > 0 && (
                <p className="publish-preview-omitted">
                  {t('Yana {0} ta o‘zgarish bor.').replace('{0}', group.omitted.toLocaleString(language))}
                </p>
              )}
            </section>
          ))}
          {preview.warningCount > 0 && (
            <p className="publish-preview-warning">
              {t('{0} ta rasm havolasi yaroqsiz deb topildi va nashr snapshotidan chiqariladi.')
                .replace('{0}', preview.warningCount.toLocaleString(language))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function CreateCode({ platform, onClose, onCreated }: { platform: 'desktop' | 'website'; onClose: () => void; onCreated: (code: string) => void }) {
  const { t } = useSiteLanguage()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { data, error: rpcError } = platform === 'website'
        ? await requireSupabase().rpc('generate_web_activation_code', { p_note: note.trim() || null })
        : await requireSupabase().rpc('generate_activation_code', { p_note: note.trim() || null })
      if (rpcError) throw rpcError
      const token = Array.isArray(data) ? data[0] : data
      if (!token?.code) throw new Error(t('Server kod yaratdi, ammo javobda kod topilmadi.'))
      onCreated(token.code as string)
    } catch (reason) {
      setError(getErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={platform === 'website' ? t('Sayt uchun 15 kunlik aktivatsiya kodi') : t('Desktop ilova uchun aktivatsiya kodi')} onClose={onClose} onSubmit={submit} busy={busy} submitLabel={t('Kod yaratish')}>
    {error && <Notice message={error} />}
    <label className="field"><span>{t('Izoh (ixtiyoriy)')}</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('Ism yoki telefon raqami')} /></label>
  </Modal>
}

function statusLabel(status: string, t: (text: string) => string) {
  return ({ PENDING: t('Kutilmoqda'), ACTIVATED: t('Faollashtirilgan'), REVOKED: t('Bekor qilingan') } as Record<string, string>)[status] || status
}

function formatDate(value: string, language: string) {
  return new Date(value).toLocaleString(language === 'ru' ? 'ru-RU' : 'uz-UZ', { dateStyle: 'medium', timeStyle: 'short' })
}
