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
    const mode = req.body?.mode ?? 'changes'
    if (mode !== 'full' && mode !== 'changes') {
      return send(res, 400, { error: 'Yuklash turi noto‘g‘ri.' })
    }

    const expectedVersion = req.body?.expectedVersion
    if (expectedVersion !== undefined && (
      typeof expectedVersion !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedVersion)
    )) {
      return send(res, 400, { error: 'Taqqoslash versiyasi noto‘g‘ri. Qaytadan solishtiring.' })
    }

    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${SITE_REPOSITORY}/actions/workflows/${PUBLISH_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: githubHeaders(admin.githubToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          ref: SITE_BRANCH,
          inputs: {
            publish_mode: mode,
            ...(expectedVersion ? { expected_version: expectedVersion } : {}),
          },
        }),
      }
    )
    if (!dispatchResponse.ok) {
      const failure = await explainGithubFailure(dispatchResponse, 'Nashrni boshlab bo‘lmadi')
      return send(res, 502, failure)
    }

    return send(res, 202, {
      message: mode === 'full'
        ? 'Supabase’dagi to‘liq baza va barcha rasm fayllari repodagi sayt ma’lumotlarini almashtirib yuklanmoqda.'
        : 'Supabase’dagi o‘zgarishlar va kerakli yangi rasm fayllari saytga yuklanmoqda.',
    })
  } catch (error) {
    console.error('[publish] Nashrni boshlashda xatolik:', error)
    return send(res, 500, { error: 'Nashrni boshlashda server xatoligi yuz berdi.' })
  }
}
