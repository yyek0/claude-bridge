import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const FILE_LIMIT = 512 * 1024
export const WRITE_LIMIT = 48_000
export const OUTPUT_LIMIT = 14_000
const WALK_LIMIT = 6000
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const searchExcluded = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.next'])
const secretNamePattern = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.password-store|\.env(?:$|[._-])|\.envrc$|\.netrc$|_netrc$|\.npmrc$|\.pypirc$|\.git-credentials$|\.docker$|\.config$|\.gradle$|\.m2$|\.yarnrc(?:\.yml)?$|\.terraform$|\.terraformrc$|id_(?:ed25519|rsa|dsa|ecdsa)(?:\.|$)|credentials(?:[._-]|$)|secrets?(?:[._-]|$)|kubeconfig(?:\.|$)|htpasswd$)|\.(?:pem|key|p12|pfx|jks|keystore|tfstate)(?:\.|$)/i
const secretTextPattern = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:sk-(?:ant-|proj-|live-|[a-zA-Z0-9])[A-Za-z0-9_-]{16,}|(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|cb_)[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{32,})\b|(?:\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[\w+/.~-]{8,}/i

export function isSecretName(name: string): boolean {
  // An explicitly named example file can be used if its contents pass the same credential scan.
  return name.toLowerCase() !== '.env.example' && secretNamePattern.test(name)
}

export function containsSecret(text: string): boolean {
  return secretTextPattern.test(text)
}

export function safeContext(text: string): string {
  return containsSecret(text) ? '[Вывод закрыт: обнаружен шаблон секрета.]' : text
}

export function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Действие отменено.')
  }
}

export function relativeParts(input: string): string[] {
  if (input === '.') {
    return []
  }
  if (!input || input.length > 1500 || /[\\:\u0000-\u001f\u007f]/.test(input) || path.isAbsolute(input)) {
    throw new Error('Нужен относительный путь внутри рабочей папки.')
  }
  const parts = input.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$|[<>|"*?]/.test(part) ||
    /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) || isSecretName(part))) {
    throw new Error('Путь запрещён или ведёт к потенциально секретным данным.')
  }
  return parts
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === ''
}

function sameStat(left: Awaited<ReturnType<typeof fs.stat>>, right: Awaited<ReturnType<typeof fs.stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export type Snapshot = { text: string; mode: number; dev: number; ino: number; mtimeMs: number }

export class Workspace {
  private constructor(readonly root: string, private readonly openedPath: string,
                      private readonly identity: Awaited<ReturnType<typeof fs.stat>>) {}

  static async open(root: string): Promise<Workspace> {
    const canonical = await fs.realpath(root)
    const identity = await fs.stat(canonical)
    if (!identity.isDirectory()) {
      throw new Error('Рабочая папка недоступна.')
    }
    return new Workspace(canonical, path.resolve(root), identity)
  }

  async resolve(input: string, kind: 'file' | 'directory' | 'new'): Promise<string> {
    const parts = relativeParts(input)
    if (!parts.length && kind !== 'directory') {
      throw new Error('Укажите файл.')
    }
    const root = await fs.lstat(this.root)
    if (root.isSymbolicLink() || !sameStat(root, this.identity) || !samePath(this.root, await fs.realpath(this.root))) {
      throw new Error('Рабочая папка изменилась.')
    }
    let target = this.root
    for (const [index, part] of parts.entries()) {
      target = path.join(target, part)
      const last = index === parts.length - 1
      const entry = await fs.lstat(target).catch(error => {
        if (missing(error) && last && kind === 'new') {
          return undefined
        }
        throw error
      })
      if (!entry) {
        return target
      }
      if (entry.isSymbolicLink() || !samePath(target, await fs.realpath(target))) {
        throw new Error('Символические ссылки и перенаправления запрещены.')
      }
      if (!last || kind === 'directory') {
        if (!entry.isDirectory()) {
          throw new Error('Ожидалась папка.')
        }
      } else if (kind === 'new') {
        throw new Error('Файл с таким именем уже существует.')
      } else if (!entry.isFile() || entry.nlink !== 1) {
        throw new Error('Разрешены обычные файлы без дополнительных жёстких ссылок.')
      }
    }
    return target
  }

  async snapshot(input: string): Promise<Snapshot> {
    const target = await this.resolve(input, 'file')
    const expected = await fs.lstat(target)
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || !sameStat(stat, expected) ||
          !sameStat(stat, await fs.lstat(await this.resolve(input, 'file')))) {
        throw new Error('Файл изменился во время проверки.')
      }
      if (stat.size > FILE_LIMIT) {
        throw new Error('Файл превышает лимит 512 КБ.')
      }
      const buffer = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const current = await handle.stat()
      if (bytesRead !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) {
        throw new Error('Файл изменился во время чтения.')
      }
      const content = buffer.subarray(0, bytesRead)
      if (content.includes(0)) {
        throw new Error('Поддерживаются текстовые файлы UTF-8.')
      }
      const text = decoder.decode(content)
      if (containsSecret(text)) {
        throw new Error('Обнаружен шаблон секрета. Файл закрыт для агента.')
      }
      return { text, mode: stat.mode, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs }
    } finally {
      await handle.close()
    }
  }

  async list(input: string, signal: AbortSignal): Promise<string> {
    const directory = await this.resolve(input, 'directory')
    const output = []
    for await (const entry of await fs.opendir(directory)) {
      checkSignal(signal)
      if (entry.isSymbolicLink() || isSecretName(entry.name) || (!entry.isFile() && !entry.isDirectory())) {
        continue
      }
      try { relativeParts(entry.name) } catch { continue }
      output.push(entry.name + (entry.isDirectory() ? '/' : ''))
      if (output.length === 200) {
        output.push('[Лимит списка]')
        break
      }
    }
    return JSON.stringify(output.sort())
  }

  async search(query: string, contents: boolean, signal: AbortSignal): Promise<string> {
    if (!query || query.length > 200 || containsSecret(query)) {
      throw new Error('Введите текст поиска длиной от 1 до 200 символов.')
    }
    const normalized = query.toLowerCase()
    const results = []
    let visited = 0
    async function* walk(workspace: Workspace, parent: string, depth: number): AsyncGenerator<string> {
      const directory = await workspace.resolve(parent, 'directory')
      for await (const entry of await fs.opendir(directory)) {
        checkSignal(signal)
        if (++visited > WALK_LIMIT) {
          return
        }
        if (entry.isSymbolicLink() || isSecretName(entry.name)) {
          continue
        }
        try { relativeParts(entry.name) } catch { continue }
        const name = parent === '.' ? entry.name : parent + '/' + entry.name
        if (entry.isDirectory() && !searchExcluded.has(entry.name) && depth < 18) {
          try {
            yield* walk(workspace, name, depth + 1)
          } catch {
            checkSignal(signal)
          }
        } else if (entry.isFile()) {
          yield name
        }
      }
    }
    for await (const file of walk(this, '.', 0)) {
      checkSignal(signal)
      if (!contents) {
        if (file.toLowerCase().includes(normalized)) {
          results.push(file)
        }
      } else {
        const snapshot = await this.snapshot(file).catch(() => undefined)
        if (!snapshot) {
          continue
        }
        const lines = snapshot.text.split(/\r?\n/)
        for (const [index, line] of lines.entries()) {
          if (line.toLowerCase().includes(normalized)) {
            results.push({ path: file, line: index + 1, text: line.slice(0, 400) })
            if (results.length === 40) {
              break
            }
          }
        }
      }
      if (results.length === 40) {
        break
      }
    }
    return JSON.stringify({ results, capped: visited > WALK_LIMIT || results.length === 40 })
  }

  async editorFile(absolute: string): Promise<string> {
    const original = path.relative(this.openedPath, absolute)
    const viaCanonical = original === '..' || original.startsWith('..' + path.sep) || path.isAbsolute(original)
    const relative = (viaCanonical ? path.relative(this.root, absolute) : original).split(path.sep).join('/')
    const target = await this.resolve(relative, 'file')
    if (!samePath(target, await fs.realpath(absolute))) {
      throw new Error('Путь открытого файла изменился.')
    }
    return relative
  }
}
