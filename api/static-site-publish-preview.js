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
const maxImageBytes = 100_000_000
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpg', '.png', '.tif', '.webp'])
const mimeExtensions = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpg': '.jpg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tif',
  'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
}

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

async function fetchGithubFile(filePath, token, resourceName) {
  const response = await fetch(githubContentsUrl(`public/data/${filePath}`), {
    headers: githubHeaders(token, { Accept: 'application/vnd.github.raw' }),
  })
  if (!response.ok) {
    const failure = await explainGithubFailure(response, `${resourceName} o‘qib bo‘lmadi`)
    throw Object.assign(new Error(failure.error), { status: 502 })
  }
  const responseText = await response.text()
  try {
    const envelope = JSON.parse(responseText)
    if (envelope?.encoding === 'base64' && typeof envelope.content === 'string') {
      return Buffer.from(envelope.content, 'base64').toString('utf8')
    }
  } catch {
    // Raw GitHub contents are already plain text.
  }
  return responseText
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
    !/^[a-f0-9]{64}$/.test(pointer.version)
  ) {
    throw Object.assign(new Error('GitHub versiya ko‘rsatkichi noto‘g‘ri formatda.'), {
      status: 502,
    })
  }

  const readSnapshot = async (version, filePath) => {
    if (
      typeof version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(version) ||
      filePath !== `snapshots/${version}.json`
    ) {
      throw Object.assign(new Error('GitHub snapshot manzili noto‘g‘ri.'), { status: 502 })
    }
    const snapshotText = await fetchGithubFile(filePath, token, 'GitHub snapshot’i')
    let snapshot
    try {
      snapshot = JSON.parse(snapshotText)
    } catch {
      throw Object.assign(new Error('GitHub snapshot’i JSON formatida emas.'), { status: 502 })
    }
    if (
      !snapshot ||
      snapshot.schemaVersion !== 1 ||
      !Array.isArray(snapshot.questions) ||
      !snapshot.catalog ||
      !Array.isArray(snapshot.catalog.sections) ||
      !Array.isArray(snapshot.catalog.lessons) ||
      !Array.isArray(snapshot.lessonQuestionOrder) ||
      createHash('sha256').update(snapshotText).digest('hex') !== version
    ) {
      throw Object.assign(new Error('GitHub snapshot formati yoki checksum noto‘g‘ri.'), {
        status: 502,
      })
    }
    return snapshot
  }

  if (pointer.schemaVersion !== 2) {
    return {
      version: pointer.version,
      snapshot: await readSnapshot(pointer.version, pointer.snapshot),
      imageAssets: [],
      incrementalReady: false,
    }
  }

  const baseline = pointer.baseline
  if (
    !baseline ||
    typeof baseline.version !== 'string' ||
    !Array.isArray(pointer.deltas)
  ) {
    throw Object.assign(new Error('GitHub incremental versiya ko‘rsatkichi noto‘g‘ri.'), {
      status: 502,
    })
  }
  let version = baseline.version
  let snapshot = await readSnapshot(baseline.version, baseline.snapshot)
  for (const descriptor of pointer.deltas) {
    if (
      descriptor.fromVersion !== version ||
      typeof descriptor.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.version) ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      typeof descriptor.path !== 'string' ||
      !/^deltas\/[a-f0-9]{64}\.json$/.test(descriptor.path)
    ) {
      throw Object.assign(new Error('GitHub delta zanjiri noto‘g‘ri formatda.'), {
        status: 502,
      })
    }
    const deltaText = await fetchGithubFile(descriptor.path, token, 'GitHub delta fayli')
    if (createHash('sha256').update(deltaText).digest('hex') !== descriptor.sha256) {
      throw Object.assign(new Error('GitHub delta checksum bilan mos kelmadi.'), {
        status: 502,
      })
    }
    const delta = JSON.parse(deltaText)
    if (delta.fromVersion !== version || delta.toVersion !== descriptor.version) {
      throw Object.assign(new Error('GitHub delta versiyalari zanjir bilan mos kelmadi.'), {
        status: 502,
      })
    }
    snapshot = applySnapshotDelta(snapshot, delta)
    version = snapshotHash(snapshot)
    if (version !== descriptor.version) {
      throw Object.assign(new Error('Yig‘ilgan snapshot versiyasi delta bilan mos kelmadi.'), {
        status: 502,
      })
    }
  }
  if (version !== pointer.version) {
    throw Object.assign(new Error('Joriy GitHub versiyasi delta zanjiri bilan mos kelmadi.'), {
      status: 502,
    })
  }
  if (pointer.imageAssets !== undefined && !Array.isArray(pointer.imageAssets)) {
    throw Object.assign(new Error('GitHub rasm fayllari ro‘yxati noto‘g‘ri.'), {
      status: 502,
    })
  }
  const imageAssets = pointer.imageAssets || []
  for (const asset of imageAssets) {
    if (
      typeof asset.path !== 'string' ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes >= maxImageBytes
    ) {
      throw Object.assign(new Error('GitHub rasm fayllari ro‘yxatida noto‘g‘ri yozuv bor.'), {
        status: 502,
      })
    }
  }
  return {
    version,
    snapshot,
    imageAssets,
    incrementalReady: Array.isArray(pointer.imageAssets),
  }
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

function imageStoragePath(image) {
  if (image.status === 'missing' || image.status === 'missing_remote') return null
  const bucketPath = image.storage_path || storagePathFromUrl(image.storage_url)
  if (!bucketPath) {
    throw new Error(`Rasm uchun storage path topilmadi: ${image.id || 'ID yo‘q'}`)
  }
  const normalizedPath = bucketPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const pathParts = normalizedPath.split('/')
  if (pathParts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Rasm storage path noto‘g‘ri: ${normalizedPath}`)
  }
  return normalizedPath
}

function imageExtension(contentType, sourcePath) {
  const mimeType = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  if (mimeType && !mimeType.startsWith('image/') && mimeType !== 'application/octet-stream') {
    throw new Error(`Storage fayli rasm emas (${mimeType}): ${sourcePath}`)
  }
  const sourceExtension = sourcePath.match(/\.[^.\\/]+$/)?.[0].toLowerCase()
  const extension = mimeExtensions[mimeType] ||
    (sourceExtension === '.jpeg'
      ? '.jpg'
      : imageExtensions.has(sourceExtension)
        ? sourceExtension
        : null)
  if (!extension) throw new Error(`Rasm formatini aniqlab bo‘lmadi: ${sourcePath}`)
  return extension
}

async function downloadImage(supabase, sourcePath) {
  const { data, error } = await supabase.storage.from(bucketName).download(sourcePath)
  if (error) {
    throw new Error(`Rasmni Supabase Storage’dan olishda xatolik (${sourcePath}): ${error.message}`)
  }
  if (!data) throw new Error(`Supabase Storage rasm qaytarmadi: ${sourcePath}`)
  const bytes = Buffer.from(await data.arrayBuffer())
  if (!bytes.length) throw new Error(`Supabase Storage’dagi rasm bo‘sh: ${sourcePath}`)
  if (bytes.length >= maxImageBytes) {
    throw new Error(`Rasm GitHub’ning 100 MB fayl cheklovidan oshdi: ${sourcePath}`)
  }
  const extension = imageExtension(data.type, sourcePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  return {
    path: `images/${digest}${extension}`,
    storagePath: `/data/images/${digest}${extension}`,
    bytes: bytes.length,
  }
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = nextIndex++
        if (index >= items.length) return
        results[index] = await callback(items[index])
      }
    })
  )
  return results
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

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function snapshotHash(snapshot) {
  return createHash('sha256')
    .update(`${stableStringify(snapshot)}\n`)
    .digest('hex')
}

function recordDelta(before, after, keyOf) {
  const previous = new Map((before || []).map((record) => [keyOf(record), record]))
  const current = new Map((after || []).map((record) => [keyOf(record), record]))
  const upsert = []
  const remove = []
  for (const [key, record] of current) {
    if (stableStringify(previous.get(key)) !== stableStringify(record)) upsert.push(record)
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) remove.push(key)
  }
  return { upsert, remove }
}

export function createSnapshotDelta(before, after, fromVersion, toVersion) {
  const settingsChanged =
    stableStringify(before.catalog.settings || {}) !==
    stableStringify(after.catalog.settings || {})
  return {
    schemaVersion: 1,
    fromVersion,
    toVersion,
    catalog: {
      sections: recordDelta(before.catalog.sections, after.catalog.sections, (row) => String(row.id)),
      lessons: recordDelta(before.catalog.lessons, after.catalog.lessons, (row) => String(row.id)),
      manual_variants: recordDelta(
        before.catalog.manual_variants,
        after.catalog.manual_variants,
        (row) => String(row.id)
      ),
      settingsChanged,
      ...(settingsChanged ? { settings: after.catalog.settings || {} } : {}),
    },
    questions: recordDelta(
      before.questions,
      after.questions,
      (row) => `${row.question_source || 'base'}:${row.id}`
    ),
    lessonQuestionOrder: recordDelta(
      before.lessonQuestionOrder,
      after.lessonQuestionOrder,
      (row) => `${row.question_source}:${row.question_id}`
    ),
  }
}

function numberCompare(left, right) {
  return Number(left) - Number(right)
}

function textCompare(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function timestampCompare(left, right) {
  const millisecondDifference = Date.parse(left) - Date.parse(right)
  if (millisecondDifference) return millisecondDifference
  const fraction = (value) => {
    const digits = String(value).match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] || ''
    return digits.slice(0, 6).padEnd(6, '0')
  }
  return textCompare(fraction(left), fraction(right))
}

function mergeRecords(previous, patch, keyOf, compare) {
  if (!patch || !Array.isArray(patch.upsert) || !Array.isArray(patch.remove)) {
    throw new Error('Delta yozuvlari noto‘g‘ri formatda.')
  }
  const records = new Map((previous || []).map((record) => [keyOf(record), record]))
  for (const key of patch.remove) records.delete(String(key))
  for (const record of patch.upsert) records.set(keyOf(record), record)
  return [...records.values()].sort(compare)
}

export function applySnapshotDelta(snapshot, delta) {
  if (
    !snapshot ||
    delta?.schemaVersion !== 1 ||
    typeof delta.fromVersion !== 'string' ||
    typeof delta.toVersion !== 'string' ||
    !delta.catalog ||
    !delta.questions ||
    !delta.lessonQuestionOrder
  ) {
    throw new Error('Snapshot delta formati noto‘g‘ri.')
  }
  const catalog = snapshot.catalog
  return {
    schemaVersion: snapshot.schemaVersion,
    catalog: {
      ...catalog,
      sections: mergeRecords(
        catalog.sections,
        delta.catalog.sections,
        (row) => String(row.id),
        (a, b) => numberCompare(a.sort_order, b.sort_order) || numberCompare(a.id, b.id)
      ),
      lessons: mergeRecords(
        catalog.lessons,
        delta.catalog.lessons,
        (row) => String(row.id),
        (a, b) =>
          numberCompare(a.section_id, b.section_id) ||
          numberCompare(a.sort_order, b.sort_order) ||
          numberCompare(a.id, b.id)
      ),
      manual_variants: mergeRecords(
        catalog.manual_variants,
        delta.catalog.manual_variants,
        (row) => String(row.id),
        (a, b) => numberCompare(a.sort_order, b.sort_order) || numberCompare(a.id, b.id)
      ),
      settings: delta.catalog.settingsChanged ? delta.catalog.settings : catalog.settings,
    },
    questions: mergeRecords(
      snapshot.questions,
      delta.questions,
      (row) => `${row.question_source || 'base'}:${row.id}`,
      (a, b) =>
        timestampCompare(a.updated_at, b.updated_at) ||
        numberCompare(a.id, b.id)
    ),
    lessonQuestionOrder: mergeRecords(
      snapshot.lessonQuestionOrder,
      delta.lessonQuestionOrder,
      (row) => `${row.question_source}:${row.question_id}`,
      (a, b) =>
        numberCompare(a.lesson_id, b.lesson_id) ||
        numberCompare(a.sort_order, b.sort_order) ||
        textCompare(a.question_source, b.question_source) ||
        numberCompare(a.question_id, b.question_id)
    ),
  }
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

export function makePreview(
  before,
  after,
  currentVersion,
  nextVersion,
  snapshotJson,
  fullUploadRequired = currentVersion === null,
  imageUploadBytes = 0
) {
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

  let totalChanges = changes.reduce((total, group) => total + group.total, 0)
  const contentChanged =
    before === null || stableStringify(before) !== stableStringify(after)
  const hasChanges = fullUploadRequired || contentChanged
  if (contentChanged && totalChanges === 0) {
    changes.push({
      title: 'Snapshot',
      added: 0,
      updated: 1,
      deleted: 0,
      total: 1,
      items: [{ action: 'updated', label: 'Snapshot tarkibi o‘zgardi' }],
      omitted: 0,
    })
    totalChanges = 1
  }
  const dataBytes = !hasChanges
    ? 0
    : fullUploadRequired || before === null
      ? Buffer.byteLength(snapshotJson, 'utf8')
      : Buffer.byteLength(
          `${stableStringify(createSnapshotDelta(before, after, currentVersion, nextVersion))}\n`,
          'utf8'
        )
  return {
    currentVersion,
    snapshotVersion: hasChanges ? nextVersion : (currentVersion || nextVersion),
    fullUploadRequired,
    hasChanges,
    totalChanges,
    uploadBytes: dataBytes + (hasChanges ? imageUploadBytes : 0),
    imageUploadBytes: hasChanges ? imageUploadBytes : 0,
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

    const imageSourcePaths = new Set()
    const imagePathFor = (image) => imageStoragePath(image)
    for (const row of rows) {
      for (const image of row.images || []) {
        const sourcePath = imagePathFor(image)
        if (sourcePath) imageSourcePaths.add(sourcePath)
      }
    }
    const fallbackImage = catalog.settings?.no_question_image_url
    const fallbackImageSourcePath =
      typeof fallbackImage === 'string' && fallbackImage
        ? imagePathFor({
          storage_url: fallbackImage,
          status: 'available',
        })
        : null
    if (fallbackImageSourcePath) imageSourcePaths.add(fallbackImageSourcePath)

    const imagePaths = [...imageSourcePaths]
    const downloadedImages = new Map(
      (await mapWithConcurrency(imagePaths, 6, (sourcePath) =>
        downloadImage(supabase, sourcePath)
      )).map((asset, index) => [imagePaths[index], asset])
    )
    for (const row of rows) {
      row.images = (row.images || []).map((image) => {
        const sourcePath = imagePathFor(image)
        if (!sourcePath) return { ...image, storage_path: null, storage_url: null }
        const asset = downloadedImages.get(sourcePath)
        return {
          ...image,
          status: 'available',
          storage_path: asset.storagePath,
          storage_url: null,
        }
      })
    }
    if (fallbackImageSourcePath) {
      catalog.settings.no_question_image_url =
        downloadedImages.get(fallbackImageSourcePath).storagePath
    }

    const snapshot = { schemaVersion: 1, catalog, questions: rows, lessonQuestionOrder }
    const snapshotJson = `${stableStringify(snapshot)}\n`
    const snapshotVersion = snapshotHash(snapshot)
    const currentImagePaths = new Set(
      (current?.imageAssets || []).map((asset) => asset.path)
    )
    const candidateImageAssets = new Map(
      [...downloadedImages.values()].map((asset) => [asset.path, asset])
    )
    const imageUploadBytes = [...candidateImageAssets.values()].reduce(
      (total, asset) => total + (currentImagePaths.has(asset.path) ? 0 : asset.bytes),
      0
    )
    const preview = makePreview(
      current?.snapshot,
      snapshot,
      current?.version || null,
      snapshotVersion,
      snapshotJson,
      !current?.incrementalReady,
      imageUploadBytes
    )
    return send(res, 200, { ...preview, warningCount: 0 })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    console.error('[publish-preview] Taqqoslashda xatolik:', error)
    return send(res, status, {
      error: error?.message || 'Sayt ma’lumotlarini taqqoslab bo‘lmadi.',
    })
  }
}
