import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'
import { installTooltips } from './tooltips'

declare function acquireVsCodeApi(): {
  postMessage(message: object): void
  getState(): { model?: string; tools?: boolean } | undefined
  setState(value: { model?: string; tools?: boolean }): void
}

for (const [name, syntax] of Object.entries({ bash, css, javascript, json, powershell, python, sql, typescript, xml, yaml, diff })) {
  hljs.registerLanguage(name, syntax)
}
const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  highlight: (code, language) => language && code.length <= 20_000 && hljs.getLanguage(language)
    ? hljs.highlight(code, { language, ignoreIllegals: true }).value : '',
})
markdown.disable('image')

const api = acquireVsCodeApi()
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const prompt = el<HTMLTextAreaElement>('prompt')
const model = el<HTMLSelectElement>('model')
const folders = el<HTMLSelectElement>('folders')
const allow = el<HTMLInputElement>('allow')
const dialogs = el<HTMLSelectElement>('dialogs')
const history = el('history')
const current = el('turn')
const scroller = el('scroll')
const refreshTooltips = installTooltips(el('tooltip'))

type Turn = { text: string; output: string; stopping: boolean }
type Message = { prompt: string; answer: string }
type State = {
  status: 'unconfigured' | 'connecting' | 'online' | 'offline' | 'denied'
  connectionDetail: string; notice: string; dialogs: { id: string; title: string }[]; selected?: string
  historyVersion: number; history: Message[]; models: string[]; attachments: string[]; activity: string
  turn?: Turn; approval?: { id: string; title: string; detail: string; action: string }
  folders: { id: string; name: string }[]; folder?: string; trusted: boolean
}

const labels = {
  unconfigured: 'Требуется подключение', connecting: 'Подключение…', online: 'Сервер подключён',
  offline: 'Переподключение…', denied: 'Доступ отклонён',
}

let state: State | undefined
let selectedModel = api.getState()?.model ?? ''
allow.checked = api.getState()?.tools ?? false
let historyVersion = -1
let pending: State | undefined
let frame = 0
let lastTurn: Turn | undefined

function send(type: string, extra: object = {}) { api.postMessage({ type, ...extra }) }

function savePreferences() { api.setState({ model: selectedModel, tools: allow.checked }) }

function toggle(id: string, visible: boolean) { el(id).hidden = !visible }

function setSelect(select: HTMLSelectElement, options: [string, string][], value?: string) {
  const signature = JSON.stringify(options)
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...options.map(([id, label]) => new Option(label, id)))
    select.dataset.signature = signature
  }
  if (value !== undefined) {
    select.value = value
  }
}

function updateSend() {
  el<HTMLButtonElement>('send').disabled = state?.status !== 'online' || !!state.turn || !prompt.value.trim() || !model.value
}

function message(role: 'user' | 'assistant', text: string) {
  const article = document.createElement('article')
  article.className = role
  const label = document.createElement('div')
  label.className = 'message-label'
  label.textContent = role === 'user' ? 'Вы' : 'Агент'
  const content = document.createElement('div')
  content.className = 'message-body'
  article.append(label, content)
  if (role === 'assistant') {
    renderMarkdown(content, text)
  } else {
    content.textContent = text
  }
  return article
}

function renderMarkdown(content: HTMLElement, text: string) {
  const fragment = DOMPurify.sanitize(markdown.render(text), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['href', 'class', 'start'], ALLOW_DATA_ATTR: false,
  })
  content.replaceChildren(fragment)
}

function render(next: State) {
  const nearEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 52
  const switched = state?.selected !== next.selected
  state = next
  const online = next.status === 'online'
  const blocked = !next.trusted || !next.folder || !!next.turn
  const status = el('status')
  status.textContent = labels[next.status]
  status.dataset.state = next.status
  status.title = next.connectionDetail
  toggle('configure', !online && !next.turn)
  setSelect(dialogs, [['', 'Диалоги'], ...next.dialogs.map(item => [item.id, item.title] as [string, string])], next.selected || '')
  dialogs.disabled = !online || !!next.turn
  el<HTMLButtonElement>('new').disabled = dialogs.disabled
  selectedModel = next.models.includes(selectedModel) ? selectedModel : (next.models[0] ?? selectedModel)
  if (next.models.length) {
    savePreferences()
  }
  setSelect(model, next.models.length ? next.models.map(name => [name, name.replace(':', ' · ')]) : [['', 'Модель']], next.models.length ? selectedModel : '')
  model.disabled = !online || !!next.turn
  setSelect(folders, next.folders.length ? next.folders.map(item => [item.id, item.name]) : [['', 'Нет папки']], next.folder ?? '')
  folders.disabled = !!next.turn || next.folders.length < 2
  allow.disabled = blocked
  el<HTMLButtonElement>('attach').disabled = blocked
  el<HTMLButtonElement>('selection').disabled = blocked
  toggle('empty', !next.turn && !next.history.length)
  el('empty-detail').textContent = online ? 'Отправьте сообщение или выберите существующий диалог.'
    : 'Нажмите «Подключить» и вставьте токен устройства (cb_…).'
  const notice = next.notice || (next.status === 'offline' || next.status === 'unconfigured' ? next.connectionDetail : '')
  toggle('notice', !!notice)
  el('notice').textContent = notice
  toggle('activity', !!next.activity)
  el('activity').textContent = next.activity
  toggle('stop', !!next.turn)
  el<HTMLButtonElement>('stop').disabled = next.turn?.stopping ?? false
  el<HTMLButtonElement>('stop').textContent = next.turn?.stopping ? 'Остановка…' : 'Стоп'
  toggle('send', !next.turn)
  updateSend()

  if (historyVersion !== next.historyVersion) {
    historyVersion = next.historyVersion
    const fragment = document.createDocumentFragment()
    for (const item of next.history) {
      fragment.append(message('user', item.prompt), message('assistant', item.answer))
    }
    history.replaceChildren(fragment)
  }
  if (!next.turn) {
    if (lastTurn) { current.replaceChildren() }
  } else if (!lastTurn || lastTurn.text !== next.turn.text) {
    current.replaceChildren(message('user', next.turn.text), message('assistant', next.turn.output))
  } else if (lastTurn.output !== next.turn.output) {
    renderMarkdown(current.lastElementChild!.lastElementChild as HTMLElement, next.turn.output)
  }
  lastTurn = next.turn
  if (nearEnd || switched) {
    scroller.scrollTop = scroller.scrollHeight
  }

  const list = el('attachments')
  const signature = JSON.stringify(next.attachments)
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature
    const items = next.attachments.map((label, index) => {
      const item = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = label
      name.title = label
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.tooltip = 'Убрать это вложение из следующего сообщения.'
      button.setAttribute('aria-label', 'Убрать вложение: ' + label)
      button.textContent = '×'
      button.addEventListener('click', () => send('remove', { index }))
      item.append(name, button)
      return item
    })
    list.replaceChildren(...items)
  }
  list.hidden = !next.attachments.length
  toggle('approval', !!next.approval)
  if (next.approval) {
    el('approval-title').textContent = next.approval.title
    el('approval-detail').textContent = next.approval.detail
    el('accept').textContent = next.approval.action
  }
  refreshTooltips()
}

function submit() {
  if (!el<HTMLButtonElement>('send').disabled) {
    send('prompt', { text: prompt.value, model: model.value, tools: allow.checked && !allow.disabled })
  }
}

el('compose').addEventListener('submit', event => { event.preventDefault(); submit() })
prompt.addEventListener('input', updateSend)
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault()
    submit()
  }
})
model.addEventListener('change', () => { selectedModel = model.value; savePreferences(); updateSend() })
allow.addEventListener('change', savePreferences)
dialogs.addEventListener('change', () => { if (dialogs.value) { send('open', { dialog: dialogs.value }) } })
folders.addEventListener('change', () => { send('folder', { folder: folders.value }) })
for (const [id, event] of Object.entries({ configure: 'configure', new: 'new', stop: 'cancel', attach: 'attach', selection: 'selection' })) {
  el(id).addEventListener('click', () => send(event))
}
for (const [id, accept] of [['accept', true], ['reject', false]] as const) {
  el(id).addEventListener('click', () => {
    if (state?.approval) { send('approval', { id: state.approval.id, accept }) }
  })
}
scroller.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest('a')
  if (link) {
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) { send('link', { href }) }
  }
})
window.addEventListener('message', event => {
  const message = event.data
  if (message?.type === 'sent' && prompt.value === message.text) {
    prompt.value = ''
    updateSend()
  } else if (message?.type === 'state') {
    pending = message
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pending) { render(pending) }
        pending = undefined
      })
    }
  }
})
send('ready')
