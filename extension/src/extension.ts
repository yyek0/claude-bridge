import { randomBytes, randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { attachmentPath, LocalTools, Preview } from './localTools'
import { checkEndpoint, checkTarget, Transport, type Status } from './transport'
import { containsSecret, Workspace } from './workspace'

type Attachment = { label: string; text: string; folder: string }
type Dialog = { id: string; title: string }
type Message = { prompt: string; answer: string }
type Turn = { dialog: string; text: string; output: string; scope?: Workspace; folder?: string; controller: AbortController;
  call?: string; seen: Set<string>; stopping: boolean }
type Approval = { id: string; title: string; detail: string; action: string; finish: (accepted: boolean) => void }

const SECRET = 'claudeBridge.device'
const TOKEN = /^cb_[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function settings() {
  const config = vscode.workspace.getConfiguration('claudeBridge')
  const global = <T>(key: string) => {
    const value = config.inspect<T>(key)
    return (value?.globalValue ?? value?.defaultValue) as T
  }
  const endpoint = checkEndpoint(global<string>('endpoint')).href
  const target = global<string>('sshTarget').trim()
  const remotePort = global<number>('sshRemotePort')
  if (target) {
    checkTarget(target, remotePort)
    if (new URL(endpoint).protocol !== 'ws:') {
      throw new Error('Автоматический SSH-туннель использует локальный ws://.')
    }
  }
  return { endpoint, target, remotePort }
}

class Chat implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private connection: Status = 'unconfigured'
  private connectionDetail = ''
  private notice = ''
  private dialogs: Dialog[] = []
  private selected?: string
  private history: Message[] = []
  private historyVersion = 0
  private models: string[] = []
  private attachments: Attachment[] = []
  private turn?: Turn
  private approval?: Approval
  private activity = ''
  private folder?: string
  private submitting = false
  private syncOnNextList = false
  private generation = 0
  private readonly transport = new Transport((state, detail) => this.status(state, detail), message => this.receive(message))
  private readonly tools: LocalTools

  constructor(private readonly context: vscode.ExtensionContext, preview: Preview) {
    const saved = context.workspaceState.get<string>('dialog')
    this.selected = saved && UUID.test(saved) ? saved : undefined
    this.tools = new LocalTools(preview, (title, detail, action, signal) => new Promise(resolve => {
      if (signal.aborted) {
        resolve(false)
        return
      }
      const id = randomUUID()
      const finish = (accepted: boolean) => {
        signal.removeEventListener('abort', abort)
        if (this.approval?.id === id) {
          this.approval = undefined
          this.render()
        }
        resolve(accepted && !signal.aborted)
      }
      const abort = () => finish(false)
      signal.addEventListener('abort', abort, { once: true })
      this.approval = { id, title, detail, action, finish }
      this.render()
    }))
  }

  async connect() {
    const generation = ++this.generation
    this.transport.stop()
    this.endTurn()
    try {
      const config = settings()
      const secret = await this.context.secrets.get(SECRET)
      if (generation !== this.generation) {
        return
      }
      const saved = secret ? JSON.parse(secret) : undefined
      if (!saved || !TOKEN.test(saved.token) || saved.endpoint !== config.endpoint ||
          saved.target !== config.target || saved.remotePort !== config.remotePort) {
        this.status('unconfigured', saved ? 'Подтвердите токен для нового адреса.' : undefined)
        return
      }
      this.transport.start(config, saved.token)
    } catch (error) {
      if (generation === this.generation) {
        this.status('unconfigured', (error as Error).message)
      }
    }
  }

  async configure() {
    try {
      const config = settings()
      const peer = config.target || config.endpoint
      const token = await vscode.window.showInputBox({
        title: 'Токен устройства Claude Bridge', prompt: peer, password: true, ignoreFocusOut: true,
        validateInput: value => TOKEN.test(value.trim()) ? undefined : 'Вставьте полный токен устройства (cb_…).',
      })
      if (token) {
        await this.context.secrets.store(SECRET, JSON.stringify({ ...config, token: token.trim() }))
        this.resetHistory()
        await this.connect()
      }
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message)
    }
  }

  async disconnect() {
    await this.context.secrets.delete(SECRET)
    this.resetHistory()
    await this.connect()
  }

  private resetHistory() {
    this.dialogs = []
    this.selected = undefined
    this.setHistory([])
    this.attachments = []
    this.models = []
    this.notice = ''
    void this.context.workspaceState.update('dialog', undefined)
  }

  dispose() {
    this.generation += 1
    this.transport.stop()
    this.endTurn()
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    const webview = view.webview
    webview.options = { enableScripts: true, localResourceRoots: [
      vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
    ] }
    webview.html = this.html(webview)
    const subscription = webview.onDidReceiveMessage(message => {
      void this.fromWebview(message).catch(error => {
        this.notice = (error as Error).message
        this.render()
      })
    })
    view.onDidDispose(() => {
      subscription.dispose()
      if (this.view === view) {
        this.view = undefined
      }
    })
  }

  private html(webview: vscode.Webview) {
    const asset = (directory: string, file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, directory, file))
    const nonce = randomBytes(24).toString('base64')
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="${asset('media', 'chat.css')}"><title>Claude Bridge</title></head>
<body>
  <header class="top">
    <div class="connection-row"><span id="status" data-state="connecting" role="status"></span><button id="configure" class="quiet" type="button">Подключить</button></div>
    <div class="dialog-row">
      <select id="dialogs" aria-label="Диалоги"></select>
      <button id="new" class="square" type="button" title="Новый диалог" aria-label="Новый диалог">+</button>
    </div>
  </header>
  <main id="scroll" tabindex="0" aria-label="Переписка">
    <div id="empty" class="empty"><h1>Claude Bridge</h1><p id="empty-detail">Откройте диалог, чтобы начать работу.</p></div>
    <div id="history"></div><div id="turn"></div>
  </main>
  <footer>
    <div id="notice" role="status" hidden></div>
    <section id="approval" aria-label="Подтверждение действия" hidden>
      <strong id="approval-title"></strong><pre id="approval-detail"></pre>
      <div class="approval-actions"><button id="reject" type="button">Отклонить</button><button id="accept" class="primary" type="button"></button></div>
    </section>
    <div id="activity" role="status" hidden></div>
    <form id="compose">
      <ul id="attachments" aria-label="Вложения" hidden></ul>
      <textarea id="prompt" rows="3" maxlength="12000" aria-label="Запрос" placeholder="Сообщение или задача для агента"></textarea>
      <div class="compose-actions">
        <select id="model" aria-label="Модель"></select>
        <button id="attach" class="square" title="Прикрепить файл" aria-label="Прикрепить файл" type="button">↥</button>
        <button id="selection" class="square" title="Добавить выделение" aria-label="Добавить выделение" type="button">⌗</button>
        <button id="send" class="primary" type="submit">Отправить</button>
        <button id="stop" type="button" hidden>Стоп</button>
      </div>
    </form>
    <div class="scope"><label><input id="allow" type="checkbox"> Доступ к рабочей папке</label>
      <select id="folders" aria-label="Рабочая папка"></select></div>
  </footer>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body></html>`
  }

  private folders() {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
  }

  private folderFor(id?: string) {
    const folders = this.folders()
    const target = id ?? this.folder
    return target ? folders.find(folder => folder.uri.toString() === target) : folders[0]
  }

  async addSelection() {
    try {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        throw new Error('Сначала выделите текст в локальном редакторе.')
      }
      await vscode.commands.executeCommand('claudeBridge.chat.focus')
      const folder = this.folderFor()
      if (!folder) {
        throw new Error('Выберите рабочую папку.')
      }
      if (editor.document.uri.scheme !== 'file') {
        throw new Error('Выделение доступно в локальных файлах.')
      }
      const relative = await (await Workspace.open(folder.uri.fsPath)).editorFile(editor.document.uri.fsPath)
      this.queue(folder, relative + ' · выделение', editor.document.getText(editor.selection))
      this.render()
    } catch (error) {
      void vscode.window.showWarningMessage((error as Error).message)
    }
  }

  refresh() {
    if (this.turn?.folder && !this.folderFor(this.turn.folder)) {
      this.cancel()
    }
    if (this.folder && !this.folderFor(this.folder)) {
      this.folder = undefined
      this.attachments = []
    }
    this.render()
  }

  private queue(folder: vscode.WorkspaceFolder, label: string, text: string) {
    if (this.turn || !vscode.workspace.isTrusted) {
      throw new Error('Остановите текущий запрос или откройте доверенную рабочую папку.')
    }
    if (containsSecret(text) || text.includes('\0')) {
      throw new Error('Вложение содержит шаблон секрета или двоичные данные.')
    }
    if (text.length > 12_000 || label.length > 300 ||
        this.attachments.reduce((sum, item) => sum + Buffer.byteLength(item.text), Buffer.byteLength(text)) > 32_000 ||
        this.attachments.length >= 8) {
      throw new Error('Превышен лимит вложений. Используйте выделение или уменьшите объём текста.')
    }
    this.attachments.push({ label, text, folder: folder.uri.toString() })
    this.notice = ''
  }

  private async attach() {
    const folder = this.folderFor()
    if (!folder || !vscode.workspace.isTrusted) {
      throw new Error('Откройте доверенную локальную папку.')
    }
    const uris = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectMany: true,
      canSelectFolders: false, canSelectFiles: true, openLabel: 'Прикрепить' })
    if (uris?.length) {
      const scope = await Workspace.open(folder.uri.fsPath)
      for (const uri of uris) {
        const relative = attachmentPath(folder, uri)
        this.queue(folder, relative, (await scope.snapshot(relative)).text)
      }
      this.render()
    }
  }

  private setHistory(history: Message[]) {
    this.history = history
    this.historyVersion += 1
  }

  private open(dialog: string, create = false) {
    if (!this.transport.send({ type: create ? 'create' : 'open', dialog })) {
      return
    }
    this.selected = dialog
    this.setHistory([])
    this.notice = ''
    void this.context.workspaceState.update('dialog', dialog)
    this.render()
  }

  private async prompt(message: Record<string, unknown>) {
    if (this.connection !== 'online' || this.turn || this.submitting || typeof message.text !== 'string' ||
        !message.text.trim() || message.text.length > 12_000 || typeof message.model !== 'string' ||
        !this.models.includes(message.model)) {
      return
    }
    if (containsSecret(message.text)) {
      throw new Error('В запросе обнаружен шаблон секрета.')
    }
    const folder = this.folderFor()
    if (this.attachments.some(item => item.folder !== folder?.uri.toString()) ||
        (this.attachments.length && !vscode.workspace.isTrusted)) {
      throw new Error('Вложения доступны только в выбранной доверенной папке.')
    }
    const generation = this.generation
    this.submitting = true
    try {
      const scope = message.tools === true && folder && vscode.workspace.isTrusted
        ? await Workspace.open(folder.uri.fsPath) : undefined
      if (generation !== this.generation || this.connection !== 'online') {
        return
      }
      let dialog = this.selected
      if (!dialog) {
        dialog = randomUUID()
        this.open(dialog, true)
      }
      const attachments = this.attachments.map(({ label, text }) => ({ label, text }))
      if (!this.transport.send({ type: 'prompt', dialog, text: message.text, model: message.model, tools: !!scope, attachments })) {
        return
      }
      this.turn = { dialog, text: message.text, output: '', controller: new AbortController(), scope,
        folder: scope && folder?.uri.toString(), seen: new Set(), stopping: false }
      this.attachments = []
      this.notice = ''
      this.activity = 'Модель готовит ответ'
      void this.view?.webview.postMessage({ type: 'sent', text: message.text })
      this.render()
    } finally {
      this.submitting = false
    }
  }

  private async fromWebview(message: Record<string, unknown>) {
    if (!message || typeof message !== 'object') {
      return
    }
    switch (message.type) {
      case 'ready': this.render(); break
      case 'configure': await this.configure(); break
      case 'new':
        if (!this.turn && !this.submitting) { this.open(randomUUID(), true) }
        break
      case 'open':
        if (!this.turn && !this.submitting && typeof message.dialog === 'string' &&
            this.dialogs.some(dialog => dialog.id === message.dialog)) { this.open(message.dialog) }
        break
      case 'folder':
        if (!this.turn && !this.submitting && typeof message.folder === 'string' && this.folderFor(message.folder)) {
          this.folder = message.folder
          this.attachments = []
          this.render()
        }
        break
      case 'attach': await this.attach(); break
      case 'selection': await this.addSelection(); break
      case 'remove':
        if (!this.turn && typeof message.index === 'number' && Number.isSafeInteger(message.index) && message.index >= 0) {
          this.attachments.splice(message.index, 1)
          this.render()
        }
        break
      case 'prompt': await this.prompt(message); break
      case 'cancel': this.cancel(); break
      case 'approval':
        if (this.approval && message.id === this.approval.id) { this.approval.finish(message.accept === true) }
        break
      case 'link':
        if (typeof message.href === 'string' && message.href.length <= 2000) {
          const url = new URL(message.href)
          if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
            const confirm = await vscode.window.showInformationMessage('Открыть ссылку из ответа агента?', {
              modal: true, detail: url.href,
            }, 'Открыть')
            if (confirm === 'Открыть') { await vscode.env.openExternal(vscode.Uri.parse(url.href)) }
          }
        }
        break
    }
  }

  private cancel() {
    if (this.turn && !this.turn.stopping) {
      this.turn.stopping = true
      this.turn.controller.abort()
      this.transport.send({ type: 'cancel' })
      this.activity = 'Остановка запроса'
      this.render()
    }
  }

  private status(status: Status, detail?: string) {
    this.connection = status
    this.connectionDetail = detail ?? ''
    if (status !== 'online' && this.turn) {
      this.endTurn()
      this.notice = 'Соединение потеряно. Проверьте результаты уже подтверждённых локальных действий.'
    }
    this.render()
  }

  private endTurn() {
    this.turn?.controller.abort()
    this.turn = undefined
    this.approval?.finish(false)
    this.activity = ''
  }

  private receive(message: Record<string, unknown>) {
    const turn = this.turn
    if (message.type === 'ready') {
      this.models = message.models as string[]
      this.syncOnNextList = true
    } else if (message.type === 'dialogs' && Array.isArray(message.dialogs)) {
      this.dialogs = (message.dialogs as Dialog[]).filter(item => item && UUID.test(item.id) && typeof item.title === 'string')
      if (!turn && this.selected && !this.dialogs.some(item => item.id === this.selected)) {
        this.selected = undefined
        this.setHistory([])
        void this.context.workspaceState.update('dialog', undefined)
      }
      if (this.syncOnNextList) {
        this.syncOnNextList = false
        if (!turn && this.selected) { this.transport.send({ type: 'open', dialog: this.selected }) }
      }
    } else if (message.type === 'changed') {
      this.transport.send({ type: 'list' })
      if (!turn && this.selected) {
        this.transport.send({ type: 'open', dialog: this.selected })
      }
    } else if (message.type === 'history' && message.dialog === this.selected && Array.isArray(message.turns)) {
      this.setHistory((message.turns as Message[]).filter(item => item && typeof item.prompt === 'string' && typeof item.answer === 'string'))
    } else if (message.type === 'error') {
      this.notice = typeof message.message === 'string' ? message.message : 'Ошибка сервера.'
      if (turn && message.dialog === turn.dialog) {
        this.endTurn()
      }
    } else if (turn && message.dialog === turn.dialog) {
      if (message.type === 'delta' && typeof message.text === 'string' && !turn.stopping) {
        turn.output = (turn.output + message.text).slice(0, 48_000)
      } else if (message.type === 'tool') {
        void this.handleTool(turn, message).catch(() => {
          this.notice = 'Не удалось вернуть результат локального инструмента.'
          this.render()
        })
      } else if (message.type === 'tool_end' && message.call === turn.call) {
        // The local deadline is shorter than the server's tool deadline.
        this.approval?.finish(false)
      } else if (message.type === 'done') {
        if (!turn.stopping) {
          this.setHistory([...this.history, { prompt: turn.text, answer: turn.output }].slice(-100))
        }
        this.endTurn()
        this.transport.send({ type: 'open', dialog: turn.dialog })
      } else if (message.type === 'cancelled') {
        this.endTurn()
        this.notice = 'Генерация остановлена. Уже подтверждённые локальные действия сохраняются.'
      }
    }
    this.render()
  }

  private async handleTool(turn: Turn, message: Record<string, unknown>) {
    const { call, name, arguments: args } = message
    if (turn.stopping || turn.call || typeof call !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call) ||
        typeof name !== 'string' || turn.seen.has(call) || turn.seen.size >= 8) {
      return
    }
    turn.seen.add(call)
    turn.call = call
    this.activity = 'Инструмент · ' + name.slice(0, 80)
    this.render()
    const result = turn.scope ?
      await this.tools.execute(turn.scope, { call, name, arguments: args as Record<string, unknown> }, turn.controller.signal) :
      { error: true, text: 'Пользователь не включил доступ к рабочей папке.' }
    if (this.turn !== turn || turn.stopping) {
      return
    }
    turn.call = undefined
    this.activity = 'Модель обрабатывает результат'
    this.transport.send({ type: 'result', call, ...result })
    this.render()
  }

  private render() {
    const folder = this.folderFor()
    const approval = this.approval
    void this.view?.webview.postMessage({
      type: 'state', status: this.connection, connectionDetail: this.connectionDetail, notice: this.notice,
      dialogs: this.dialogs, selected: this.selected, historyVersion: this.historyVersion, history: this.history, models: this.models,
      attachments: this.attachments.map(item => item.label), activity: this.activity,
      turn: this.turn && { text: this.turn.text, output: this.turn.output, stopping: this.turn.stopping },
      approval: approval && { id: approval.id, title: approval.title, detail: approval.detail, action: approval.action },
      folders: this.folders().map(item => ({ id: item.uri.toString(), name: item.name })),
      folder: folder?.uri.toString(), trusted: vscode.workspace.isTrusted,
    })
  }
}

export function activate(context: vscode.ExtensionContext) {
  const preview = new Preview()
  const chat = new Chat(context, preview)
  context.subscriptions.push(chat, vscode.workspace.registerTextDocumentContentProvider('claude-bridge-diff', preview),
    vscode.window.registerWebviewViewProvider('claudeBridge.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeBridge.configure', () => chat.configure()),
    vscode.commands.registerCommand('claudeBridge.disconnect', () => chat.disconnect()),
    vscode.commands.registerCommand('claudeBridge.addSelection', () => chat.addSelection()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('claudeBridge')) { void chat.connect() }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => chat.refresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => chat.refresh()))
  void chat.connect()
}
