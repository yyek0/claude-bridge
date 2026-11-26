import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import * as vscode from 'vscode'
import { checkSignal, OUTPUT_LIMIT, safeContext } from './workspace'

export function systemShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const file = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $global:LASTEXITCODE=0; & { ' + command +
      '\n}; if (!$?) { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }'
    return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
  }
  const shell = process.env.SHELL
  const file = shell && /^\/(?:[\w.-]+\/)*(?:bash|zsh|sh)$/.test(shell) ? shell : '/bin/sh'
  return { file, args: ['-c', command] }
}

function terminate(child: ChildProcess) {
  if (!child.pid) {
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
    killer.on('exit', code => { if (code) child.kill() })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill()
  }
}

function filteredEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|NODE_OPTIONS$|BASH_ENV$|ENV$)|(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(key)))
}

export async function runProcess(file: string, args: string[], cwd: string, signal: AbortSignal, terminalName?: string): Promise<string> {
  checkSignal(signal)
  const env = filteredEnv()
  if (!terminalName) {
    // Git only. Avoid helpers, optional index writes, inherited Git config, and interactive prompts.
    Object.assign(env, { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat',
      LC_ALL: 'C.UTF-8' })
  }

  const output = new vscode.EventEmitter<string>()
  let terminal: vscode.Terminal | undefined
  const child = spawn(file, args, {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const emit = (value: string) => {
    // Render text as output, without interpreting ANSI/OSC control sequences from a process.
    output.fire(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').replace(/\r?\n/g, '\r\n'))
  }
  const stop = () => terminate(child)
  const deadline = setTimeout(stop, terminalName ? 90_000 : 15_000)
  const onCancel = () => stop()
  signal.addEventListener('abort', onCancel, { once: true })
  if (terminalName) {
    terminal = vscode.window.createTerminal({
      name: terminalName,
      pty: {
        onDidWrite: output.event,
        open: () => emit('Claude Bridge · ' + cwd + '\n'),
        close: stop,
        handleInput: (data: string) => { if (data.includes('\x03')) stop() },
      },
    })
    terminal.show(true)
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      let captured = ''
      let displayed = 0
      const collect = (text: string) => {
        if (displayed < 120_000) {
          const section = text.slice(0, 120_000 - displayed)
          displayed += section.length
          emit(section)
          if (displayed === 120_000) { emit('\n[Лимит отображения вывода]\n') }
        }
        if (captured.length < OUTPUT_LIMIT + 512) {
          captured += text.slice(0, OUTPUT_LIMIT + 512 - captured.length)
        }
      }
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8')
        stream.on('data', (chunk: Buffer) => collect(decoder.write(chunk)))
        stream.on('end', () => collect(decoder.end()))
      }
      child.once('error', reject)
      child.once('close', (code, bySignal) => {
        const status = code === null ? ('Прервано' + (bySignal ? ' (' + bySignal + ')' : '')) : 'Код выхода: ' + code
        emit('\n' + status + '\n')
        if (code !== 0) {
          reject(new Error(status + '\n' + safeContext(captured).slice(0, OUTPUT_LIMIT)))
        } else {
          resolve(status + '\n' + safeContext(captured).slice(0, OUTPUT_LIMIT))
        }
      })
    })
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onCancel)
    output.dispose()
  }
}
