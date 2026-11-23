import { verifyActiveAdmin } from '../server/adminAuth.js'

const REPOSITORY = 'AsliddinXoliqulov/Azizbek_avto_test_ilova'
const BRANCH = 'main'

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return send(res, 405, { error: 'Faqat GET so‘rovi ruxsat etilgan.' })
  }

  try {
    const admin = await verifyActiveAdmin(req)
    if (!admin.ok) return send(res, admin.status, { error: admin.error })

    const versionResponse = await fetch(
      `https://api.github.com/repos/${REPOSITORY}/contents/public/data/version.json?ref=${BRANCH}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${admin.githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    )
    let since = new Date(0).toISOString()
    if (versionResponse.ok) {
      const file = await versionResponse.json()
      if (typeof file.content !== 'string' || file.encoding !== 'base64') {
        return send(res, 502, { error: 'Nashr qilingan versiya faylini o‘qib bo‘lmadi.' })
      }
      const pointer = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
      const publishedTime = Date.parse(pointer.publishedAt)
      if (Number.isFinite(publishedTime)) {
        since = new Date(publishedTime).toISOString()
      }
    } else if (versionResponse.status !== 404) {
      console.error('[publish-status] GitHub versiya javobi:', versionResponse.status)
      return send(res, 502, { error: 'Oxirgi sayt nashri holatini olib bo‘lmadi.' })
    }

    const countResponse = await fetch(
      `${admin.supabaseUrl}/rest/v1/rpc/count_unpublished_site_changes`,
      {
        method: 'POST',
        headers: {
          apikey: admin.serviceRoleKey,
          Authorization: `Bearer ${admin.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_since: since }),
      }
    )
    if (!countResponse.ok) {
      console.error('[publish-status] Supabase o‘zgarishlar soni javobi:', countResponse.status)
      return send(res, 502, {
        error: 'Kutilayotgan o‘zgarishlar sonini hisoblab bo‘lmadi. Supabase nashr migratsiyasini tekshiring.',
      })
    }
    const countValue = await countResponse.json()
    const pendingChanges = Number(countValue)
    if (!Number.isSafeInteger(pendingChanges) || pendingChanges < 0) {
      return send(res, 502, { error: 'Supabase kutilayotgan o‘zgarishlar sonini noto‘g‘ri qaytardi.' })
    }

    return send(res, 200, { pendingChanges, publishedAt: since })
  } catch (error) {
    console.error('[publish-status] Nashr holatini tekshirishda xatolik:', error)
    return send(res, 500, { error: 'Nashr holatini tekshirishda server xatoligi yuz berdi.' })
  }
}
