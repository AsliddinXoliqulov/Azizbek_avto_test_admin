import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { verifyActiveAdmin } from '../server/adminAuth.js'
import {
  SITE_BRANCH,
  SITE_REPOSITORY,
  explainGithubFailure,
  githubHeaders,
} from '../server/github.js'

const pageSize = 1000
const bucketName = 'pdd-images'
const storagePublicMarker = `/storage/v1/object/public/${bucketName}/`

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

function githubContentsUrl(filePath) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return (
    `https://api.github.com/repos/${SITE_REPOSITORY}/contents/${encodedPath}` +
    `?ref=${encodeURIComponent(SITE_BRANCH)}`
  )
}

async function fetchCurrentSnapshot(token) {
  const versionResponse = await fetch(githubContentsUrl('public/data/version.json'), {
    headers: githubHeaders(token),
  })
  if (versionResponse.status === 404) return null
  if (!versionResponse.ok) {
    const failure = await explainGithubFailure(versionResponse, 'GitHub versiyasini o‘qib bo‘lmadi')
    throw Object.assign(new Error(failure.error), { status: 502 })
  }

  const versionFile = await versionResponse.json()
  if (versionFile.encoding !== 'base64' || typeof versionFile.content !== 'string') {
    throw Object.assign(new Error('GitHub versiya fayli noto‘g‘ri formatda.'), { status: 502 })
  }
  const pointer = JSON.parse(Buffer.from(versionFile.content, 'base64').toString('utf8'))
  if (
    typeof pointer.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pointer.version) ||
    pointer.snapshot !== `snapshots/${pointer.version}.json`
  ) {
    throw Object.assign(new Error('GitHub versiya ko‘rsatkichi noto‘g‘ri formatda.'), {
      status: 502,
    })
  }

  const snapshotResponse = await fetch(
    githubContentsUrl(`public/data/${pointer.snapshot}`),
    { headers: githubHeaders(token, { Accept: 'application/vnd.github.raw' }) }
  )
  if (!snapshotResponse.ok) {
    const failure = await explainGithubFailure(snapshotResponse, 'GitHub snapshot’ini o‘qib bo‘lmadi')
    throw Object.assign(new Error(failure.error), { status: 502 })
  }

  const responseText = await snapshotResponse.text()
  let snapshotText = responseText
  let snapshot
  try {
    snapshot = JSON.parse(responseText)
    if (snapshot?.encoding === 'base64' && typeof snapshot.content === 'string') {
      snapshotText = Buffer.from(snapshot.content, 'base64').toString('utf8')
      snapshot = JSON.parse(snapshotText)
    }
  } catch {
    throw Object.assign(new Error('GitHub snapshot’i JSON formatida emas.'), { status: 502 })
  }
  if (
    !snapshot ||
    !Array.isArray(snapshot.questions) ||
    !snapshot.catalog ||
    !Array.isArray(snapshot.catalog.sections) ||
    !Array.isArray(snapshot.catalog.lessons) ||
    !Array.isArray(snapshot.lessonQuestionOrder)
  ) {
    throw Object.assign(new Error('GitHub snapshot’ining tarkibi noto‘g‘ri.'), { status: 502 })
  }
  const actualVersion = createHash('sha256').update(snapshotText).digest('hex')
  if (actualVersion !== pointer.version) {
    throw Object.assign(new Error('GitHub snapshot versiyasi checksum bilan mos kelmadi.'), {
      status: 502,
    })
  }
  return { version: pointer.version, snapshot }
}

function storagePathFromUrl(value) {
  if (typeof value !== 'string' || !value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Rasm URL manzili noto‘g‘ri: ${value}`)
  }
  const markerIndex = url.pathname.indexOf(storagePublicMarker)
  if (markerIndex < 0) {
    throw new Error(`Rasm Supabase ${bucketName} omboriga tegishli emas: ${value}`)
  }
  return decodeURIComponent(url.pathname.slice(markerIndex + storagePublicMarker.length))
}

function publicStorageUrl(image, supabaseUrl) {
  const bucketPath = image.storage_path || storagePathFromUrl(image.storage_url)
  if (!bucketPath) {
    if (image.status === 'missing' || image.status === 'missing_remote') return null
    throw new Error(`Rasm uchun storage path topilmadi: ${image.id || 'ID yo‘q'}`)
  }
  const normalizedPath = bucketPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const pathParts = normalizedPath.split('/')
  if (pathParts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Rasm storage path noto‘g‘ri: ${normalizedPath}`)
  }
  const encodedPath = pathParts.map(encodeURIComponent).join('/')
  return new URL(
    `/storage/v1/object/public/${bucketName}/${encodedPath}`,
    supabaseUrl
  ).toString()
}

async function fetchCatalog(supabase) {
  const { data, error } = await supabase.rpc('sync_base_catalog', {
    p_device_id: 'static-site-publisher',
    p_since: new Date(0).toISOString(),
  })
  if (error) throw new Error(`Katalogni Supabase’dan olishda xatolik: ${error.message}`)
  if (!data || !Array.isArray(data.sections) || !Array.isArray(data.lessons)) {
    throw new Error('Supabase katalog javobi noto‘g‘ri formatda.')
  }
  const { server_time: _serverTime, ...catalog } = data
  return catalog
}

async function fetchAllQuestions(supabase) {
  const rows = []
  let cursor = { since: new Date(0).toISOString(), afterId: 0 }

  for (;;) {
    const { data, error } = await supabase.rpc('sync_base_questions', {
      p_device_id: 'static-site-publisher',
      p_since: cursor.since,
      p_after_id: cursor.afterId,
      p_limit: pageSize,
    })
    if (error) throw new Error(`Savollarni Supabase’dan olishda xatolik: ${error.message}`)
    if (!Array.isArray(data)) throw new Error('Savol sinxronlash javobi noto‘g‘ri formatda.')
    if (data.length === 0) break
    rows.push(...data)
    const last = data[data.length - 1]
    cursor = { since: last.updated_at, afterId: last.id }
    if (data.length < pageSize) break
  }
  return rows
}

async function fetchLessonQuestionOrder(supabase) {
  const { data, error } = await supabase.rpc('sync_lesson_question_order', {
    p_device_id: 'static-site-publisher',
  })
  if (error) throw new Error(`Savol tartibini Supabase’dan olishda xatolik: ${error.message}`)
  if (!Array.isArray(data)) throw new Error('Savol tartibi noto‘g‘ri formatda.')
  return data.sort((a, b) =>
    Number(a.lesson_id) - Number(b.lesson_id) ||
    Number(a.sort_order) - Number(b.sort_order) ||
    String(a.question_source).localeCompare(String(b.question_source)) ||
    Number(a.question_id) - Number(b.question_id)
  )
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function localizedText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return value['uz-Latn'] || value['uz-Cyrl'] || value.ru || ''
}

function questionLabel(question) {
  const shortText = String(localizedText(question.text)).replace(/\s+/g, ' ').trim().slice(0, 100)
  return `Savol #${question.id}${shortText ? ` — ${shortText}` : ''}`
}

function compareRecords(title, before, after, keyOf, labelOf) {
  const oldRecords = new Map((before || []).map((record) => [keyOf(record), record]))
  const newRecords = new Map((after || []).map((record) => [keyOf(record), record]))
  const keys = new Set([...oldRecords.keys(), ...newRecords.keys()])
  const result = { title, added: 0, updated: 0, deleted: 0, total: 0, items: [], omitted: 0 }

  for (const key of keys) {
    const oldRecord = oldRecords.get(key)
    const newRecord = newRecords.get(key)
    let action
    let record
    if (!oldRecord) {
      action = newRecord.is_deleted ? 'deleted' : 'added'
      record = newRecord
    } else if (!newRecord || (!oldRecord.is_deleted && newRecord.is_deleted)) {
      action = 'deleted'
      record = oldRecord
    } else if (stableStringify(oldRecord) !== stableStringify(newRecord)) {
      action = 'updated'
      record = newRecord
    } else {
      continue
    }
    result[action]++
    result.total++
    result.items.push({ action, label: labelOf(record) })
  }
  return result
}

function compareImageLinks(beforeQuestions, afterQuestions) {
  const flatten = (questions) => {
    const records = []
    for (const question of questions || []) {
      for (const [index, image] of (question.images || []).entries()) {
        records.push({
          ...image,
          question_source: question.question_source || 'base',
          question_id: question.id,
          image_index: index,
        })
      }
    }
    return records
  }
  const oldImages = flatten(beforeQuestions)
  const newImages = flatten(afterQuestions)
  const keyOf = (image) =>
    `${image.question_source}:${image.question_id}:${image.id || `${image.role}:${image.image_index}`}`
  const oldMap = new Map(oldImages.map((image) => [keyOf(image), image]))
  const newMap = new Map(newImages.map((image) => [keyOf(image), image]))
  const result = { added: 0, updated: 0, deleted: 0 }

  for (const key of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const oldImage = oldMap.get(key)
    const newImage = newMap.get(key)
    if (!oldImage) result.added++
    else if (!newImage) result.deleted++
    else if (stableStringify(oldImage) !== stableStringify(newImage)) result.updated++
  }
  return result
}

export function makePreview(before, after, currentVersion, nextVersion, snapshotJson) {
  const oldCatalog = before?.catalog || {}
  const oldQuestions = before?.questions || []
  const changes = [
    compareRecords('Bo‘limlar', oldCatalog.sections, after.catalog.sections,
      (row) => String(row.id),
      (row) => `Bo‘lim #${row.id} — ${localizedText(row.name)}`),
    compareRecords('Darslar', oldCatalog.lessons, after.catalog.lessons,
      (row) => String(row.id),
      (row) => `Dars #${row.id} — ${localizedText(row.title)}`),
    compareRecords('Savollar', oldQuestions, after.questions,
      (row) => `${row.question_source || 'base'}:${row.id}`, questionLabel),
    compareRecords('Variantlar', oldCatalog.manual_variants, after.catalog.manual_variants,
      (row) => String(row.id),
      (row) => `Variant #${row.id} — ${localizedText(row.title)}`),
    compareRecords('Savol tartibi', before?.lessonQuestionOrder, after.lessonQuestionOrder,
      (row) => `${row.question_source}:${row.question_id}`,
      (row) => `Savol #${row.question_id}, dars #${row.lesson_id}, tartib ${row.sort_order}`),
  ]

  const settingsChanged =
    stableStringify(oldCatalog.settings || {}) !== stableStringify(after.catalog.settings || {})
  if (settingsChanged) {
    changes.push({
      title: 'Sozlamalar',
      added: 0,
      updated: 1,
      deleted: 0,
      total: 1,
      items: [{ action: 'updated', label: 'Katalog sozlamalari o‘zgardi' }],
      omitted: 0,
    })
  }

  const totalChanges = changes.reduce((total, group) => total + group.total, 0)
  const hasChanges = currentVersion !== nextVersion
  if (hasChanges && totalChanges === 0) {
    changes.push({
      title: 'Snapshot',
      added: 0,
      updated: 1,
      deleted: 0,
      total: 1,
      items: [{ action: 'updated', label: 'Snapshot tarkibi o‘zgardi' }],
      omitted: 0,
    })
  }
  return {
    currentVersion,
    snapshotVersion: nextVersion,
    hasChanges,
    totalChanges: totalChanges || Number(hasChanges),
    snapshotBytes: hasChanges ? Buffer.byteLength(snapshotJson, 'utf8') : 0,
    changes: changes.filter((group) => group.total > 0),
    imageChanges: compareImageLinks(oldQuestions, after.questions),
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { error: 'Faqat POST so‘rovi ruxsat etilgan.' })
  }

  try {
    const admin = await verifyActiveAdmin(req)
    if (!admin.ok) return send(res, admin.status, { error: admin.error })

    const supabase = createClient(admin.supabaseUrl, admin.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const [current, catalog, rows, lessonQuestionOrder] = await Promise.all([
      fetchCurrentSnapshot(admin.githubToken),
      fetchCatalog(supabase),
      fetchAllQuestions(supabase),
      fetchLessonQuestionOrder(supabase),
    ])

    const warnings = []
    for (const row of rows) {
      row.images = (row.images || []).map((image) => {
        try {
          const storageUrl = publicStorageUrl(image, admin.supabaseUrl)
          return storageUrl
            ? { ...image, storage_path: null, storage_url: storageUrl }
            : { ...image, storage_path: null, storage_url: null }
        } catch (error) {
          warnings.push(`Savol ${row.id}: ${error.message}`)
          return { ...image, status: 'missing', storage_path: null, storage_url: null }
        }
      })
    }

    const fallbackImage = catalog.settings?.no_question_image_url
    if (typeof fallbackImage === 'string' && fallbackImage) {
      try {
        catalog.settings.no_question_image_url = publicStorageUrl({
          storage_url: fallbackImage,
          status: 'available',
        }, admin.supabaseUrl)
      } catch (error) {
        warnings.push(`Standart rasm: ${error.message}`)
        delete catalog.settings.no_question_image_url
      }
    }

    const snapshot = { schemaVersion: 1, catalog, questions: rows, lessonQuestionOrder }
    const snapshotJson = `${JSON.stringify(snapshot)}\n`
    const snapshotVersion = createHash('sha256').update(snapshotJson).digest('hex')
    const preview = makePreview(
      current?.snapshot,
      snapshot,
      current?.version || null,
      snapshotVersion,
      snapshotJson
    )
    return send(res, 200, { ...preview, warningCount: warnings.length })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    console.error('[publish-preview] Taqqoslashda xatolik:', error)
    return send(res, status, {
      error: error?.message || 'Sayt ma’lumotlarini taqqoslab bo‘lmadi.',
    })
  }
}
