import { verifyActiveAdmin } from '../server/adminAuth.js'
import {
  PUBLISH_WORKFLOW,
  SITE_BRANCH,
  SITE_REPOSITORY,
  explainGithubFailure,
  githubHeaders,
} from '../server/github.js'

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

// Oxirgi workflow ishining holati (kutmoqda / ishlayapti / tugadi + natija).
async function latestRun(token) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${SITE_REPOSITORY}/actions/workflows/${PUBLISH_WORKFLOW}/runs` +
        `?event=workflow_dispatch&branch=${encodeURIComponent(SITE_BRANCH)}&per_page=1`,
      { headers: githubHeaders(token) }
    )
    if (!response.ok) return null
    const body = await response.json()
    const run = Array.isArray(body.workflow_runs) ? body.workflow_runs[0] : null
    if (!run) return null
    return {
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    }
  } catch (error) {
    console.error('[publish-status] Oxirgi ish holatini olib bo‘lmadi:', error)
    return null
  }
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
      `https://api.github.com/repos/${SITE_REPOSITORY}/contents/public/data/version.json?ref=${SITE_BRANCH}`,
      { headers: githubHeaders(admin.githubToken) }
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
      // 404 = hali birinchi nashr qilinmagan (normal holat). Boshqa xatolar tokenga/repoga oid.
      const failure = await explainGithubFailure(versionResponse, 'Oxirgi nashr holatini olib bo‘lmadi')
      return send(res, 502, failure)
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

    const run = await latestRun(admin.githubToken)
    return send(res, 200, { pendingChanges, publishedAt: since, run })
  } catch (error) {
    console.error('[publish-status] Nashr holatini tekshirishda xatolik:', error)
    return send(res, 500, { error: 'Nashr holatini tekshirishda server xatoligi yuz berdi.' })
  }
}
