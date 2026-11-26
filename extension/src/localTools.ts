import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { applyPatch, parsePatch } from 'diff'
import * as vscode from 'vscode'
import { runProcess, systemShell } from './processes'
import { checkSignal, containsSecret, OUTPUT_LIMIT, relativeParts, safeContext, type Snapshot, Workspace, WRITE_LIMIT } from './workspace'

type Args = Record<string, unknown>
export type ToolRequest = { call: string; name: string; arguments: Args }
export type ToolResult = { text: string; error: boolean }

const FIELDS: Record<string, Record<string, string>> = {
  list_directory: { path: 'string?' }, read_file: { path: 'string', start_line: 'number?', end_line: 'number?' },
  search_files: { query: 'string' }, search_content: { query: 'string' },
  create_file: { path: 'string', content: 'string' }, edit_file: { path: 'string', content: 'string' },
  delete_file: { path: 'string' }, apply_patch: { path: 'string', patch: 'string' },
  run_command: { command: 'string', cwd: 'string?' }, git_status: {}, git_diff: { staged: 'boolean?' },
  get_diagnostics: { path: 'string?' }, get_active_editor: {}, get_selected_text: {},
}

export class Preview implements vscode.TextDocumentContentProvider {
  private readonly text = new Map<string, string>()

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.text.get(uri.toString()) ?? ''
  }

  async show(file: string, before: string, after: string): Promise<void> {
    const id = randomUUID()
    const original = vscode.Uri.from({ scheme: 'claude-bridge-diff', path: '/' + id + '/before/' + file })
    const proposed = vscode.Uri.from({ scheme: 'claude-bridge-diff', path: '/' + id + '/after/' + file })
    this.text.set(original.toString(), before)
    this.text.set(proposed.toString(), after)
    try {
      await Promise.all([vscode.workspace.openTextDocument(original), vscode.workspace.openTextDocument(proposed)])
      await vscode.commands.executeCommand('vscode.diff', original, proposed, 'Claude Bridge · ' + file,
        { preview: true, preserveFocus: true })
    } finally {
      this.text.delete(original.toString())
      this.text.delete(proposed.toString())
    }
  }
}

export type Approve = (title: string, detail: string, action: string, signal: AbortSignal) => Promise<boolean>

function valid(request: ToolRequest): boolean {
  if (!Object.hasOwn(FIELDS, request.name)) {
    return false
  }
  const expected = FIELDS[request.name]
  const args = request.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(expected, key))) {
    return false
  }
  return Object.entries(expected).every(([name, type]) => {
    const value = args[name]
    return (value === undefined && type.endsWith('?')) || (typeof value === type.replace('?', '') &&
      (typeof value !== 'number' || (Number.isSafeInteger(value) && value > 0 && value <= 1_000_000)))
  })
}

export class LocalTools {
  constructor(private readonly preview: Preview, private readonly approve: Approve) {}

  async execute(workspace: Workspace, request: ToolRequest, signal: AbortSignal): Promise<ToolResult> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal.aborted) {
      onAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(onAbort, 165_000)
    try {
      checkSignal(controller.signal)
      if (!vscode.workspace.isTrusted || !valid(request)) {
        throw new Error('Инструмент недоступен или получил недопустимые аргументы.')
      }
      const text = await this.run(workspace, request, controller.signal)
      return { text: safeContext(text).slice(0, OUTPUT_LIMIT), error: false }
    } catch (error) {
      const reason = error as NodeJS.ErrnoException
      return { text: safeContext(reason.code ? 'Файловая операция недоступна (' + reason.code + ').' :
        (reason.message || 'Локальная операция не выполнена.')).slice(0, OUTPUT_LIMIT), error: true }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async run(workspace: Workspace, { name, arguments: args }: ToolRequest, signal: AbortSignal): Promise<string> {
    const file = args.path as string
    switch (name) {
      case 'list_directory':
        return workspace.list(file ?? '.', signal)
      case 'read_file': {
        const lines = (await workspace.snapshot(file)).text.split(/(?<=\n)/)
        const start = (args.start_line as number | undefined) ?? 1
        const end = (args.end_line as number | undefined) ?? (start + 399)
        if (end < start || end - start >= 1000) {
          throw new Error('Укажите диапазон до 1000 строк.')
        }
        return JSON.stringify({ path: file, start, total: lines.length, text: lines.slice(start - 1, end).join('').slice(0, 11_000) })
      }
      case 'search_files':
      case 'search_content':
        return workspace.search(args.query as string, name === 'search_content', signal)
      case 'create_file':
      case 'edit_file':
      case 'delete_file':
      case 'apply_patch':
        return this.change(workspace, name, file, args, signal)
      case 'run_command': {
        const command = args.command as string
        if (!command.trim() || command.length > 2000 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(command) ||
            containsSecret(command)) {
          throw new Error('Требуется одна строка команды без управляющих символов и секретов.')
        }
        const relative = (args.cwd as string | undefined) ?? '.'
        const cwd = await workspace.resolve(relative, 'directory')
        if (!await this.approve('Выполнить команду в ' + cwd, command, 'Выполнить', signal)) {
          throw new Error('Пользователь отклонил выполнение команды.')
        }
        checkSignal(signal)
        await workspace.resolve(relative, 'directory')
        const shell = systemShell(command)
        return runProcess(shell.file, shell.args, cwd, signal, 'Claude Bridge')
      }
      case 'git_status':
      case 'git_diff':
        return this.git(workspace, name, args.staged === true, signal)
      case 'get_diagnostics':
        return this.diagnostics(workspace, file)
      case 'get_active_editor':
      case 'get_selected_text': {
        const editor = vscode.window.activeTextEditor
        if (!editor || editor.document.uri.scheme !== 'file') {
          throw new Error('Откройте локальный файл в редакторе.')
        }
        const relative = await workspace.editorFile(editor.document.uri.fsPath)
        if (name === 'get_selected_text') {
          const text = editor.document.getText(editor.selection)
          if (containsSecret(text)) {
            throw new Error('Выделение содержит шаблон секрета.')
          }
          return text.slice(0, 12_000)
        }
        return JSON.stringify({ path: relative, language: editor.document.languageId, line: editor.selection.active.line + 1,
          column: editor.selection.active.character + 1, selected: !editor.selection.isEmpty, dirty: editor.document.isDirty })
      }
      default:
        throw new Error('Неизвестный инструмент.')
    }
  }

  private async diagnostics(workspace: Workspace, requested?: string) {
    if (requested) {
      await workspace.resolve(requested, 'file')
    }
    const output = []
    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file' || output.length >= 60) {
        continue
      }
      try {
        const relative = await workspace.editorFile(uri.fsPath)
        if (requested && requested !== relative) {
          continue
        }
        for (const entry of entries.slice(0, 60 - output.length)) {
          output.push({ path: relative, line: entry.range.start.line + 1, severity: entry.severity, message: entry.message.slice(0, 400) })
        }
      } catch {
        continue
      }
    }
    return JSON.stringify(output)
  }

  private async git(workspace: Workspace, name: string, staged: boolean, signal: AbortSignal) {
    await workspace.resolve('.', 'directory')
    const metadata = path.join(workspace.root, '.git')
    const git = await fs.lstat(metadata).catch(() => undefined)
    if (!git?.isDirectory() || git.isSymbolicLink() || path.relative(metadata, await fs.realpath(metadata))) {
      throw new Error('Выберите корень обычного Git-репозитория с локальной папкой .git.')
    }
    const common = ['--no-pager', '--git-dir=' + metadata, '--work-tree=' + workspace.root,
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'core.quotePath=false', '-c', 'diff.ignoreSubmodules=all']
    const command = name === 'git_status'
      ? ['status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all']
      : ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', ...(staged ? ['--cached'] : [])]
    const excludes = ['.env*', '.git*', '.ssh', '.ssh/**', '.npmrc', '.netrc', '.pypirc', '.aws/**', '.kube/**',
      'id_*', '*credentials*', '*secret*', 'kubeconfig*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.tfstate*']
    const specs = excludes.flatMap(pattern => [':(exclude,glob,icase)' + pattern, ':(exclude,glob,icase)**/' + pattern])
    return runProcess('git', [...common, ...command, '--', '.', ...specs], workspace.root, signal)
  }

  private async change(workspace: Workspace, name: string, file: string, args: Args, signal: AbortSignal): Promise<string> {
    const creating = name === 'create_file'
    const deleting = name === 'delete_file'
    const kind = creating ? 'new' : 'file'
    const target = await workspace.resolve(file, kind)
    const original = creating ? undefined : await workspace.snapshot(file)
    let proposed = deleting ? '' : args.content as string
    if (name === 'apply_patch') {
      const patch = args.patch as string
      if (!patch || patch.length > WRITE_LIMIT) {
        throw new Error('Патч превышает лимит.')
      }
      const pieces = parsePatch(patch)
      if (pieces.length !== 1 || !pieces[0].hunks.length || !pieces[0].oldFileName || !pieces[0].newFileName ||
          [pieces[0].oldFileName, pieces[0].newFileName].some(value => value !== file && value !== 'a/' + file && value !== 'b/' + file)) {
        throw new Error('Патч должен содержать изменения одного указанного файла.')
      }
      const result = applyPatch(original!.text, pieces[0], { fuzzFactor: 0 })
      if (result === false) {
        throw new Error('Патч не подходит к текущей версии файла.')
      }
      proposed = result
    }
    if (Buffer.byteLength(proposed, 'utf8') > WRITE_LIMIT || proposed.includes('\0') || containsSecret(proposed)) {
      throw new Error('Новый текст слишком большой или содержит шаблон секрета.')
    }
    if (!creating && !deleting && original?.text === proposed) {
      return 'Изменений нет.'
    }
    this.assertSaved(target)
    checkSignal(signal)
    await this.preview.show(file, original?.text ?? '', proposed)
    const action = deleting ? 'Удалить файл' : creating ? 'Создать файл' : 'Применить изменение'
    if (!await this.approve(action + ' · ' + file, target, action, signal)) {
      throw new Error('Пользователь отклонил изменение.')
    }
    checkSignal(signal)
    await workspace.resolve(file, kind)
    if (original) {
      this.assertSame(original, await workspace.snapshot(file))
    }
    this.assertSaved(target)
    checkSignal(signal)
    if (deleting) {
      await fs.unlink(target)
    } else if (creating) {
      await fs.writeFile(target, proposed, { flag: 'wx', mode: 0o644 })
    } else {
      const temporary = path.join(path.dirname(target), '.claude-bridge-' + randomUUID())
      try {
        await fs.writeFile(temporary, proposed, { flag: 'wx', mode: original!.mode & 0o777 })
        await fs.chmod(temporary, original!.mode & 0o777)
        this.assertSame(original!, await workspace.snapshot(file))
        this.assertSaved(target)
        checkSignal(signal)
        await fs.rename(temporary, target)
      } finally {
        await fs.unlink(temporary).catch(() => undefined)
      }
    }
    return action + ' · ' + file + ' · готово'
  }

  private assertSaved(target: string) {
    if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && !path.relative(target, doc.uri.fsPath) && doc.isDirty)) {
      throw new Error('В открытом файле есть несохранённые изменения.')
    }
  }

  private assertSame(before: Snapshot, after: Snapshot) {
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.text !== after.text) {
      throw new Error('Файл изменился после создания Diff.')
    }
  }
}

export function attachmentPath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  if (uri.scheme !== 'file' || folder.uri.scheme !== 'file') {
    throw new Error('Доступны локальные файлы выбранной рабочей папки.')
  }
  const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
  if (!relativeParts(relative).length) {
    throw new Error('Выберите файл.')
  }
  return relative
}
