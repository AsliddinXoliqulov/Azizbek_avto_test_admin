import { verifyActiveAdmin } from '../server/adminAuth.js'

const REPOSITORY = 'AsliddinXoliqulov/Azizbek_avto_test_ilova'
const WORKFLOW = 'publish-static-site.yml'
const BRANCH = 'main'

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
      `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${admin.githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: BRANCH }),
      }
    )
    if (!dispatchResponse.ok) {
      console.error('[publish] GitHub workflow dispatch failed:', dispatchResponse.status)
      return send(res, 502, { error: 'GitHub nashr jarayonini boshlay olmadi.' })
    }

    return send(res, 202, {
      message: 'Savol va rasmlarini GitHub/Vercel’ga nashr qilish boshlandi.',
    })
  } catch (error) {
    console.error('[publish] Nashrni boshlashda xatolik:', error)
    return send(res, 500, { error: 'Nashrni boshlashda server xatoligi yuz berdi.' })
  }
}
