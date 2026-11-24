// Sayt repozitoriyasi (ilova_sayt) bilan GitHub API orqali ishlash uchun umumiy yordamchilar.
// Repozitoriya nomi Vercel muhit o‘zgaruvchisi bilan almashtiriladi (kodni o‘zgartirish shart emas).
export const SITE_REPOSITORY =
  process.env.GITHUB_SITE_REPOSITORY || 'AsliddinXoliqulov/Azizbek_avto_test_ilova_sayt'
export const SITE_BRANCH = process.env.GITHUB_SITE_BRANCH || 'main'
export const PUBLISH_WORKFLOW = 'publish-static-site.yml'

export function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pdd-admin-panel',
    ...extra,
  }
}

export async function githubErrorMessage(response) {
  try {
    const body = await response.json()
    return typeof body?.message === 'string' ? body.message : ''
  } catch {
    return ''
  }
}

// GitHub xato javobini admin tushunadigan o‘zbekcha xabarga aylantiradi.
export async function explainGithubFailure(response, action) {
  const githubMessage = await githubErrorMessage(response)
  const status = response.status
  let hint
  if (status === 401) {
    hint = 'GitHub tokeni yaroqsiz yoki muddati tugagan. Vercel’da GITHUB_WORKFLOW_TOKEN ni yangilang.'
  } else if (status === 403) {
    hint =
      'GitHub tokeni bu amal uchun ruxsatga ega emas. Fine-grained tokenga sayt repozitoriyasi uchun ' +
      '"Actions: Read and write" va "Contents: Read" ruxsatlarini bering.'
  } else if (status === 404) {
    hint =
      `Repozitoriya yoki workflow topilmadi (${SITE_REPOSITORY}, ${PUBLISH_WORKFLOW}). ` +
      `Repozitoriya nomi to‘g‘riligini (GITHUB_SITE_REPOSITORY), workflow fayli ` +
      `.github/workflows/${PUBLISH_WORKFLOW} ${SITE_BRANCH} branchda borligini va token shu repoga ` +
      'ulanganini tekshiring.'
  } else if (status === 422) {
    hint =
      `Workflow ishga tushmadi: ${SITE_BRANCH} branch yo‘q yoki workflow faylida "workflow_dispatch" triggeri yo‘q.`
  } else {
    hint = 'GitHub kutilmagan javob qaytardi.'
  }
  console.error(`[github] ${action} muvaffaqiyatsiz: ${status} ${githubMessage}`)
  return {
    error: `${action}: ${hint}`,
    detail: { githubStatus: status, githubMessage },
  }
}
