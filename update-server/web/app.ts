import type { Deployment } from '../../build/src/components'
import type { FirmwareView, ReleaseView as Release, Status } from '../src/modules/contract'

interface AuditEvent { id: number, action: string, detail: string, createdAt: string }

function element<T extends HTMLElement = HTMLElement>(id: string) {
  const value = document.getElementById(id)
  if (!value)
    throw new Error(`Missing element: ${id}`)
  return value as T
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const value = document.createElement(tag)
  value.textContent = text
  value.className = className
  return value
}
function showError(id: string, message: string) {
  element(id).textContent = message
  element(id).hidden = !message
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

const errors: Record<string, string> = {
  invalid_token: '管理员令牌不正确。',
  unauthorized: '登录已过期，请重新登录。',
  invalid_origin: '访问地址与服务配置的 PUBLIC_URL 不一致。请使用配置的地址登录。',
  duplicate_generation: '该板型与渠道已经存在这个部署序号，请使用新的部署序号。',
  generation_not_increasing: '部署序号必须高于该板型与渠道曾经发布过的最高值。',
  upload_too_large: '文件超过服务器的上传限制。',
  immutable_object: '该组件已经上传，组件内容不可更换。',
  invalid_deployment: '部署描述符的签名或组件元数据无效。',
  invalid_firmware: '固件清单的签名、板型或写入范围无效。',
  not_publishable: '请先完成组件上传，再发布草稿。',
  rate_limited: '尝试次数过多，请稍等一分钟再登录。',
  session_limit: '当前登录会话过多，请稍后重试。',
  internal_error: '服务器处理失败，请检查服务日志后重试。',
}

function apiError(body: { error?: { code?: string, message?: string } }) {
  const code = body.error?.code ?? ''
  return errors[code] ?? body.error?.message ?? '请求失败，请重试。'
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  }
  catch {
    throw new Error('无法连接服务，请检查网络后重试。')
  }
  const data = await response.json()
  if (!response.ok) {
    if (response.status === 401 && path !== '/session')
      setAuthenticated(false)
    throw new Error(apiError(data))
  }
  return data as T
}

function formatSize(bytes: number | null) {
  if (bytes === null)
    return '待上传'
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 ** 2)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

let releases: Release[] = []
let firmwares: FirmwareView[] = []
let createKind: 'releases' | 'firmware' = 'releases'
let selectedFirmware: string | undefined
let status: Status | undefined
let selected: string | undefined
let busy = false
let createdDraft: string | undefined
let toastTimer: ReturnType<typeof setTimeout>
const statusLabels = { draft: '草稿', published: '已发布', withdrawn: '已撤回' }
const actionLabels: Record<string, string> = { create: '创建草稿', upload: '上传组件', publish: '发布版本', withdraw: '撤回版本', refresh: '清单续期' }
for (const [action, label] of Object.entries({ create: '创建固件草稿', upload: '上传固件', publish: '发布固件', withdraw: '撤回固件' }))
  actionLabels[`firmware-${action}`] = label

function toast(text: string, error = false) {
  const box = element('toast')
  box.textContent = text
  box.hidden = false
  box.toggleAttribute('data-error', error)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    box.hidden = true
  }, error ? 9000 : 4000)
}
function setAuthenticated(value: boolean) {
  element('loading').hidden = true
  element('login').hidden = value
  element('console').hidden = !value
  if (!value) {
    element<HTMLInputElement>('token').value = ''
    element<HTMLInputElement>('token').focus()
  }
}
function setBusy(value: boolean) {
  busy = value
  document.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = value
  })
}

async function perform(operation: () => Promise<void>) {
  if (busy)
    return
  setBusy(true)
  try {
    await operation()
  }
  catch (error) {
    toast(message(error), true)
  }
  finally {
    setBusy(false)
  }
}

function renderReleases() {
  const search = element<HTMLInputElement>('search').value.toLowerCase().trim()
  const board = element<HTMLSelectElement>('board-filter').value
  const channel = element<HTMLSelectElement>('channel-filter').value
  const state = element<HTMLSelectElement>('status-filter').value
  const filtered = releases.filter(release => (!search || `${release.version} ${release.generation}`.toLowerCase().includes(search)) && (!board || release.board === board) && (!channel || release.channel === channel) && (!state || release.status === state))
  element('release-count').textContent = String(releases.length)
  element('published-count').textContent = String(releases.filter(release => release.status === 'published').length)
  element('draft-count').textContent = String(releases.filter(release => release.status === 'draft').length)
  element('list-description').textContent = `显示 ${filtered.length} 个版本`
  const rows = element('release-rows')
  rows.replaceChildren()
  for (const release of filtered) {
    const row = node('tr')
    row.toggleAttribute('data-selected', selected === release.id)
    const version = node('button', release.version, 'version-button')
    version.append(node('small', String(release.generation)))
    version.addEventListener('click', () => {
      selected = release.id
      renderReleases()
    })
    const versionCell = node('td')
    versionCell.append(version)
    row.append(versionCell, node('td', release.board, 'mono'), node('td', release.channel, 'mono'), node('td', formatSize(release.objects.reduce((sum, object) => sum + object.bytes, 0)), 'size'))
    const stateCell = node('td')
    stateCell.append(node('span', statusLabels[release.status], `badge ${release.status}`))
    const actionCell = node('td')
    const action = node('button', '›', 'table-action')
    action.setAttribute('aria-label', `查看 ${release.version} 详情`)
    action.addEventListener('click', () => {
      selected = release.id
      renderReleases()
    })
    actionCell.append(action)
    row.append(stateCell, actionCell)
    rows.append(row)
  }
  element('empty').hidden = filtered.length > 0
  const noReleases = releases.length === 0
  element('empty-title').textContent = noReleases ? '准备好第一次发布' : '没有匹配的版本'
  element('empty-description').textContent = noReleases ? '创建版本，上传 签名部署和组件，审核后发布到指定渠道。' : '尝试更换筛选条件或搜索关键词。'
  element('empty-create').hidden = !noReleases
  renderDetail()
}

function renderDetail() {
  const panel = element('release-detail')
  const release = releases.find(item => item.id === selected)
  panel.hidden = !release
  panel.replaceChildren()
  if (!release)
    return
  const heading = node('div', '', 'detail-heading')
  const title = node('div')
  title.append(node('p', 'RELEASE DETAIL', 'eyebrow'), node('h2', release.version))
  const close = node('button', '×', 'quiet')
  close.setAttribute('aria-label', '关闭版本详情')
  close.addEventListener('click', () => {
    selected = undefined
    renderReleases()
  })
  heading.append(title, close)
  panel.append(heading, node('span', statusLabels[release.status], `badge ${release.status}`))
  const details = node('dl')
  for (const [key, value] of [['板型', release.board], ['渠道', release.channel], ['部署序号', String(release.generation)], ['组件', formatSize(release.objects.reduce((sum, object) => sum + object.bytes, 0))], ['创建时间', formatDate(release.createdAt)]]) {
    const entry = node('div')
    entry.append(node('dt', key), node('dd', value))
    details.append(entry)
  }
  panel.append(details)
  {
    const checksum = node('div')
    checksum.append(node('p', 'DEPLOYMENT ID', 'detail-label'), node('p', release.deploymentId, 'checksum'))
    panel.append(checksum)
  }
  panel.append(node('p', release.notes || '暂无发布说明。', 'notes'))
  const actions = node('div', '', 'detail-actions')
  if (release.status === 'draft') {
    const complete = release.objects.every(object => object.available)
    const action = node('button', complete ? '发布到渠道' : '上传组件', 'primary')
    action.disabled = busy
    action.addEventListener('click', () => {
      if (complete)
        void changeRelease(release, 'publish')
      else
        element<HTMLInputElement>('retry-file').click()
    })
    actions.append(action)
  }
  if (release.status === 'published') {
    const withdraw = node('button', '撤回此版本', 'secondary danger')
    withdraw.disabled = busy
    withdraw.addEventListener('click', () => {
      void changeRelease(release, 'withdraw')
    })
    actions.append(withdraw)
  }
  if (release.status === 'withdrawn')
    actions.append(node('p', '已停止公开分发。再次发布请创建更高部署序号 的新版本。', 'muted'))
  const names = objectNames(release)
  for (const object of release.objects) {
    const label = names.get(object.sha256)?.join(' / ') ?? object.sha256
    const item = node('p', `${label} · ${formatSize(object.bytes)} · ${object.available ? '已上传' : '待上传'}`, 'muted')
    if (release.status === 'published') {
      const link = node('a', ' 下载 ↗')
      link.href = `/v1/objects/${object.sha256}`
      item.append(link)
    }
    panel.append(item)
  }
  panel.append(actions)
}

function renderStatus(value: Status) {
  const hours = (Date.parse(value.expiresAt) - Date.now()) / 3600000
  element('expiry').textContent = value.expired ? '已过期' : hours >= 24 ? `${Math.floor(hours / 24)} 天 ${Math.floor(hours % 24)} 小时` : `${Math.max(0, Math.floor(hours))} 小时`
  element('expiry-detail').textContent = value.expired ? '请到接入与签名页面续期' : `有效至 ${formatDate(value.expiresAt)}`
  element<HTMLInputElement>('manifest-url').value = value.manifestUrl
  element('revision').textContent = `#${value.revision}`
  element('issued-at').textContent = formatDate(value.issuedAt)
  element('expires-at').textContent = formatDate(value.expiresAt)
  element('ttl').textContent = `${value.metadataTtlHours} 小时`
  element<HTMLTextAreaElement>('public-key').value = value.signing.publicKey
  element<HTMLTextAreaElement>('key-id').value = value.signing.keyId
  element('key-source').textContent = value.signing.generated ? '服务本地生成的密钥' : '配置文件提供的密钥'
  element('upload-limit').textContent = `选择组件文件，每个最大 ${formatSize(value.maxUploadBytes)}`
}

async function reload() {
  const [releaseResponse, nextStatus, auditResponse, firmwareResponse] = await Promise.all([
    api<{ releases: Release[] }>('/releases'),
    api<Status>('/status'),
    api<{ events: AuditEvent[] }>('/audit'),
    api<{ firmware: FirmwareView[] }>('/firmware'),
  ])
  releases = releaseResponse.releases
  firmwares = firmwareResponse.firmware
  status = nextStatus
  renderReleases()
  renderFirmware()
  renderStatus(status)
  const rows = element('audit-rows')
  rows.replaceChildren()
  for (const event of auditResponse.events) {
    const row = node('tr')
    row.append(node('td', formatDate(event.createdAt)), node('td', actionLabels[event.action] ?? event.action), node('td', event.detail))
    rows.append(row)
  }
}

async function confirmAction(title: string, description: string, action: string, danger = false) {
  const dialog = element<HTMLDialogElement>('confirm-dialog')
  element('confirm-title').textContent = title
  element('confirm-description').textContent = description
  element('confirm-action').textContent = action
  element('confirm-action').classList.toggle('danger', danger)
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise<boolean>((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })
  })
}

async function changeRelease(release: Release, action: 'publish' | 'withdraw') {
  const publish = action === 'publish'
  if (!await confirmAction(publish ? `发布 ${release.version}` : `撤回 ${release.version}`, publish ? `发布后，${release.board} 的 ${release.channel} 渠道将能发现并下载此版本。请确认组件已完成验证。` : '此版本将从清单中移除。其他已发布版本仍引用的组件继续提供下载，已安装的部署不受影响。', publish ? '确认发布' : '确认撤回', !publish))
    return
  await perform(async () => {
    await api(`/releases/${release.id}/${action}`, 'POST')
    await reload()
    toast(publish ? '版本已发布，清单已更新。' : '版本已撤回。')
  })
}

function renderFirmware() {
  const rows = element('firmware-rows')
  rows.replaceChildren()
  element('firmware-empty').hidden = firmwares.length > 0
  for (const firmware of firmwares) {
    const row = node('tr')
    row.append(node('td', firmware.version), node('td', firmware.board), node('td', String(firmware.generation)), node('td', statusLabels[firmware.status]), node('td', formatSize(firmware.artifactBytes)))
    const actions = node('td')
    if (firmware.status !== 'withdrawn') {
      const complete = firmware.objects.every(object => object.available)
      const action = firmware.status === 'published' ? 'withdraw' : 'publish'
      const button = node('button', !complete ? '上传固件' : action === 'publish' ? '发布固件' : '撤回固件', 'secondary')
      button.addEventListener('click', () => {
        if (!complete) {
          selectedFirmware = firmware.id
          element<HTMLInputElement>('firmware-retry-file').click()
          return
        }
        void (async () => {
          if (!await confirmAction(`${action === 'publish' ? '发布' : '撤回'} ${firmware.version}`, action === 'publish'
            ? '发布后提供独立固件下载。固件维护需要单独安排，不会随系统版本自动安装。'
            : '停止公开分发这份固件。已安装的固件保持原状。', action === 'publish' ? '确认发布' : '确认撤回', action === 'withdraw')) {
            return
          }
          await perform(async () => {
            await api(`/firmware/${firmware.id}/${action}`, 'POST')
            await reload()
          })
        })()
      })
      actions.append(button)
    }
    if (firmware.status === 'published') {
      const manifest = node('button', '下载签名清单', 'quiet')
      manifest.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([firmware.firmware], { type: 'application/json' }))
        const link = node('a')
        link.href = url
        link.download = 'firmware.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      const artifact = node('a', '下载固件', 'quiet')
      artifact.href = `/v1/objects/${firmware.artifactSha256}`
      actions.append(manifest, artifact)
    }
    row.append(actions)
    rows.append(row)
  }
}

function objectNames(release: Release | FirmwareView) {
  if ('firmware' in release) {
    const name = release.board === 'cx3576' ? 'u-boot-rockchip.bin' : release.board === 'x64' ? 'BOOTX64.EFI' : 'BOOTAA64.EFI'
    return new Map([[release.artifactSha256, [name]]])
  }
  const envelope = JSON.parse(release.deployment) as { payload: string }
  const bytes = Uint8Array.from(atob(envelope.payload), character => character.charCodeAt(0))
  const d = JSON.parse(new TextDecoder().decode(bytes)) as Deployment
  const names = new Map<string, string[]>()
  for (const [name, artifact] of [
    [d.kernel.boot.format === 'uki' ? 'boot.efi' : 'boot.itb', d.kernel.boot.artifact],
    ['support.img', d.kernel.support.image],
    ['support.roothash.p7s', d.kernel.support.signature],
    ['rootfs.img', d.rootfs.content.image],
    ['rootfs.roothash.p7s', d.rootfs.content.signature],
  ] as const) {
    names.set(artifact.sha256, [...(names.get(artifact.sha256) ?? []), name])
  }
  return names
}
async function uploadFiles(release: Release | FirmwareView, files: File[], progress?: (percent: number) => void) {
  const names = objectNames(release)
  const missing = release.objects.filter(object => !object.available)
  for (const [index, object] of missing.entries()) {
    const file = files.find(file => file.name === object.sha256 || names.get(object.sha256)?.includes(file.name))
    if (!file)
      throw new Error(`缺少组件：${names.get(object.sha256)?.join(' / ') ?? object.sha256}。草稿已保留。`)
    if (file.size !== object.bytes)
      throw new Error(`${file.name} 的长度与签名描述符不一致。`)
    await upload(`/${'firmware' in release ? 'firmware' : 'releases'}/${release.id}`, object.sha256, file, percent => progress?.(Math.round((index + percent / 100) / missing.length * 100)))
    object.available = true
  }
}
function upload(path: string, digest: string, file: File, progress?: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api${path}/objects/${digest}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.timeout = 30 * 60 * 1000
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress?.(Math.round(event.loaded / event.total * 100))
    }
    xhr.onerror = () => reject(new Error('上传连接中断，草稿已保留，可稍后重试。'))
    xhr.ontimeout = () => reject(new Error('上传超时，草稿已保留。'))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      if (xhr.status === 401)
        setAuthenticated(false)
      try {
        reject(new Error(apiError(JSON.parse(xhr.responseText))))
      }
      catch {
        reject(new Error(`上传失败（HTTP ${xhr.status}），草稿已保留。`))
      }
    }
    xhr.send(file)
  })
}

function openCreate(kind: 'releases' | 'firmware' = 'releases') {
  createKind = kind
  element('create-title').textContent = kind === 'firmware' ? '新建固件' : '新建版本'
  element('descriptor-label').textContent = kind === 'firmware' ? '签名固件清单' : '签名部署描述符'
  createdDraft = undefined
  const form = element<HTMLFormElement>('create-form')
  form.reset()
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach((input) => {
    input.disabled = false
  })
  element('save-release').textContent = '保存草稿并上传'
  element('upload-progress').hidden = true
  showError('create-error', '')
  element<HTMLDialogElement>('create-dialog').showModal()
}

element<HTMLFormElement>('create-form').addEventListener('submit', (event) => {
  event.preventDefault()
  if (busy)
    return
  void (async () => {
    showError('create-error', '')
    const form = element<HTMLFormElement>('create-form')
    try {
      const files = Array.from(element<HTMLInputElement>('artifact-file').files ?? [])
      setBusy(true)
      let release: Release | FirmwareView | undefined = [...releases, ...firmwares].find(item => item.id === createdDraft)
      if (!release) {
        const descriptor = element<HTMLInputElement>('deployment-file').files?.[0]
        if (!descriptor || descriptor.size === 0 || descriptor.size > 24576)
          throw new Error('请选择不超过 24 KiB 的签名部署描述符。')
        const data = new FormData(form)
        release = await api<Release | FirmwareView>(`/${createKind}`, 'POST', { channel: data.get('channel'), [createKind === 'firmware' ? 'firmware' : 'deployment']: await descriptor.text(), notes: data.get('notes') })
        createdDraft = release.id
        if ('firmware' in release)
          firmwares.unshift(release)
        else releases.unshift(release)
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not(#artifact-file),select,textarea').forEach((input) => {
          input.disabled = true
        })
      }
      selected = release.id
      element('upload-progress').hidden = false
      await uploadFiles(release, files, (percent) => {
        element<HTMLProgressElement>('progress-bar').value = percent
        element('progress-label').textContent = percent === 100 ? '上传完成，正在校验并保存…' : `正在上传 ${percent}%`
      })
      element<HTMLDialogElement>('create-dialog').close()
      await reload()
      toast('草稿与组件已保存，确认后即可发布。')
    }
    catch (error) {
      showError('create-error', message(error))
      if (createdDraft) {
        element('save-release').textContent = '重试上传'
        await reload().catch(() => {})
      }
    }
    finally {
      setBusy(false)
    }
  })()
})

element<HTMLInputElement>('retry-file').addEventListener('change', () => {
  const files = Array.from(element<HTMLInputElement>('retry-file').files ?? [])
  const release = releases.find(item => item.id === selected)
  element<HTMLInputElement>('retry-file').value = ''
  if (files.length && release) {
    void perform(async () => {
      try {
        await uploadFiles(release, files)
      }
      finally { await reload() }
      toast('组件已上传。')
    })
  }
})
element<HTMLInputElement>('firmware-retry-file').addEventListener('change', () => {
  const input = element<HTMLInputElement>('firmware-retry-file')
  const files = Array.from(input.files ?? [])
  input.value = ''
  const firmware = firmwares.find(record => record.id === selectedFirmware)
  if (files.length && firmware) {
    void perform(async () => {
      try {
        await uploadFiles(firmware, files)
      }
      finally { await reload() }
      toast('固件已上传。')
    })
  }
})
element<HTMLFormElement>('login-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void perform(async () => {
    showError('login-error', '')
    try {
      await api('/session', 'POST', { token: element<HTMLInputElement>('token').value })
      element<HTMLInputElement>('token').value = ''
      await reload()
      setAuthenticated(true)
    }
    catch (error) {
      showError('login-error', message(error))
    }
  })
})
element('logout').addEventListener('click', () => {
  void perform(async () => {
    await api('/session', 'DELETE')
    setAuthenticated(false)
  })
})
element('reload').addEventListener('click', () => {
  void perform(async () => {
    await reload()
    toast('已刷新。')
  })
})
for (const id of ['new-release', 'empty-create'])
  element(id).addEventListener('click', () => openCreate())
element('new-firmware').addEventListener('click', () => openCreate('firmware'))
for (const id of ['close-create', 'cancel-create']) {
  element(id).addEventListener('click', () => {
    if (!busy)
      element<HTMLDialogElement>('create-dialog').close()
  })
}
element<HTMLDialogElement>('create-dialog').addEventListener('cancel', (event) => {
  if (busy)
    event.preventDefault()
})
for (const id of ['search', 'board-filter', 'channel-filter', 'status-filter'])
  element(id).addEventListener('input', renderReleases)
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
  button.addEventListener('click', () => {
    const page = button.dataset.page
    document.querySelectorAll<HTMLElement>('.page').forEach((section) => {
      section.hidden = section.id !== `page-${page}`
    })
    document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((nav) => {
      nav.removeAttribute('aria-current')
    })
    button.setAttribute('aria-current', 'page')
    element('breadcrumb').textContent = { releases: '发布管理', firmware: '固件维护', connection: '接入与签名', audit: '操作记录' }[page ?? ''] ?? ''
  })
})
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制。')
  }
  catch {
    toast('浏览器不允许复制，请从文本框中手动复制。', true)
  }
}
element('copy-url').addEventListener('click', () => {
  if (status)
    void copy(status.manifestUrl)
})
element('copy-trust').addEventListener('click', () => {
  if (status)
    void copy(status.signing.publicKey)
})
element('refresh-metadata').addEventListener('click', () => {
  void perform(async () => {
    await api('/metadata/refresh', 'POST')
    await reload()
    toast('清单已重新签发。')
  })
})

try {
  const session = await api<{ authenticated: boolean }>('/session')
  if (session.authenticated)
    await reload()
  setAuthenticated(session.authenticated)
}
catch (error) {
  setAuthenticated(false)
  showError('login-error', message(error))
}
