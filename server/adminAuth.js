export async function verifyActiveAdmin(req) {
  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const githubToken = process.env.GITHUB_WORKFLOW_TOKEN
  const missing = [
    ['SUPABASE_URL', supabaseUrl],
    ['SUPABASE_ANON_KEY', anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
    ['GITHUB_WORKFLOW_TOKEN', githubToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    return {
      ok: false,
      status: 500,
      error:
        'Nashr xizmati sozlanmagan. Vercel (admin panel loyihasi) → Settings → Environment Variables ' +
        `bo‘limida quyidagilar yo‘q: ${missing.join(', ')}. Qo‘shgach loyihani Redeploy qiling.`,
    }
  }

  const accessToken = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]
  if (!accessToken) {
    return { ok: false, status: 401, error: 'Admin sessiyasi topilmadi.' }
  }

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    })
    if (!userResponse.ok) {
      return {
        ok: false,
        status: 401,
        error: 'Admin sessiyasi yaroqsiz yoki muddati tugagan.',
      }
    }
    const user = await userResponse.json()
    if (typeof user.id !== 'string') {
      return { ok: false, status: 401, error: 'Admin hisobini aniqlab bo‘lmadi.' }
    }

    const profileUrl = new URL(`${supabaseUrl}/rest/v1/admins`)
    profileUrl.searchParams.set('select', 'id')
    profileUrl.searchParams.set('id', `eq.${user.id}`)
    profileUrl.searchParams.set('is_active', 'eq.true')
    const profileResponse = await fetch(profileUrl, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    })
    if (!profileResponse.ok) {
      return { ok: false, status: 502, error: 'Admin ruxsatini tekshirib bo‘lmadi.' }
    }
    const profiles = await profileResponse.json()
    if (!Array.isArray(profiles) || profiles.length !== 1) {
      return { ok: false, status: 403, error: 'Faol admin ruxsati talab qilinadi.' }
    }

    return { ok: true, supabaseUrl, serviceRoleKey, githubToken }
  } catch (error) {
    console.error('[admin-auth] Admin sessiyasini tekshirib bo‘lmadi:', error)
    return { ok: false, status: 502, error: 'Admin ruxsatini tekshirishda xatolik.' }
  }
}
