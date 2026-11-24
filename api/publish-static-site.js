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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { error: 'Faqat POST so‘rovi ruxsat etilgan.' })
  }

  try {
    const admin = await verifyActiveAdmin(req)
    if (!admin.ok) return send(res, admin.status, { error: admin.error })

    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${SITE_REPOSITORY}/actions/workflows/${PUBLISH_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: githubHeaders(admin.githubToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ref: SITE_BRANCH }),
      }
    )
    if (!dispatchResponse.ok) {
      const failure = await explainGithubFailure(dispatchResponse, 'Nashrni boshlab bo‘lmadi')
      return send(res, 502, failure)
    }

    return send(res, 202, {
      message:
        'Nashr boshlandi: savollar va rasmlar Supabase’dan olinib sayt repozitoriyasiga yuklanmoqda. ' +
        'Tugagach Vercel saytni avtomatik yangilaydi.',
    })
  } catch (error) {
    console.error('[publish] Nashrni boshlashda xatolik:', error)
    return send(res, 500, { error: 'Nashrni boshlashda server xatoligi yuz berdi.' })
  }
}
