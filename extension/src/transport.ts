import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import * as path from 'node:path'
import WebSocket from 'ws'

export type Status = 'unconfigured' | 'connecting' | 'online' | 'offline' | 'denied'
type Settings = { endpoint: string; target: string; remotePort: number }

export function checkEndpoint(value: string): URL {
  const url = new URL(value)
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!(url.protocol === 'wss:' || (url.protocol === 'ws:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new Error('Укажите wss:// или ws://127.0.0.1:порт/ws для SSH-туннеля.')
  }
  return url
}

export function checkTarget(target: string, port: number): void {
  if (!/^(?:[\w][\w.-]*@)?(?:[\w][\w.-]*|\[[a-fA-F0-9:]+\])$/.test(target) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Укажите SSH-алиас или user@host и корректный порт.')
  }
}

function vacantPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error || !address || typeof address === 'string') {
          reject(error ?? new Error('Локальный порт недоступен.'))
        } else {
          resolve(address.port)
        }
      })
    })
  })
}

export class Transport {
  private socket?: WebSocket
  private ssh?: ChildProcess
  private timer?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setInterval>
  private failures = 0
  private generation = 0
  private ready = false
  private token = ''
  private settings?: Settings

  constructor(private readonly status: (state: Status, detail?: string) => void,
              private readonly receive: (message: Record<string, unknown>) => void) {}

  start(settings: Settings, token: string) {
    this.stop()
    this.settings = settings
    this.token = token
    this.failures = 0
    void this.connect(this.generation)
  }

  stop() {
    this.generation += 1
    this.ready = false
    this.token = ''
    this.settings = undefined
    clearTimeout(this.timer)
    clearInterval(this.deadline)
    this.socket?.terminate()
    this.ssh?.kill()
    this.socket = undefined
    this.ssh = undefined
  }

  send(message: object): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
      return false
    }
    const frame = JSON.stringify(message)
    if (Buffer.byteLength(frame) > 124_000) {
      throw new Error('Сообщение слишком большое.')
    }
    this.socket.send(frame)
    return true
  }

  private retry(generation: number, detail?: string) {
    if (generation !== this.generation) {
      return
    }
    clearInterval(this.deadline)
    clearTimeout(this.timer)
    this.ready = false
    this.ssh?.kill()
    this.ssh = undefined
    this.status('offline', detail)
    this.timer = setTimeout(() => { void this.connect(generation) }, Math.min(20_000, 750 * (2 ** Math.min(this.failures++, 5))))
  }

  private async connect(generation: number) {
    const settings = this.settings
    if (!settings || generation !== this.generation) {
      return
    }
    this.status('connecting')
    try {
      const url = settings.target ? await this.tunnel(settings, generation) : checkEndpoint(settings.endpoint).href
      if (generation !== this.generation) {
        return
      }
      const socket = new WebSocket(url, {
        headers: { Authorization: 'Bearer ' + this.token }, handshakeTimeout: 7000,
        followRedirects: false, maxPayload: 1_500_000, perMessageDeflate: false,
      })
      this.socket = socket
      let lastActivity = Date.now()
      let rejected = false
      const current = () => generation === this.generation && socket === this.socket
      socket.on('error', () => { /* close drives reconnection */ })
      socket.on('unexpected-response', (_request, response) => {
        if (current() && (response.statusCode === 401 || response.statusCode === 403)) {
          rejected = true
          this.status('denied', 'Сервер отклонил подключение устройства.')
        }
        response.resume()
        socket.terminate()
      })
      socket.on('open', () => {
        this.deadline = setInterval(() => {
          if (current() && Date.now() - lastActivity > (this.ready ? 55_000 : 10_000)) {
            socket.terminate()
          }
        }, 5000)
      })
      socket.on('ping', () => { lastActivity = Date.now() })
      socket.on('message', (raw, binary) => {
        if (!current() || binary) {
          return
        }
        lastActivity = Date.now()
        try {
          const value: unknown = JSON.parse(raw.toString())
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Некорректное сообщение сервера.')
          }
          const message = value as Record<string, unknown>
          if (!this.ready) {
            if (message.type !== 'ready' || message.protocol !== 1 || !Array.isArray(message.models) ||
                !message.models.every(model => typeof model === 'string')) {
              rejected = true
              this.status('denied', 'Несовместимая версия протокола.')
              socket.terminate()
              return
            }
            this.ready = true
            this.failures = 0
            this.status('online')
          }
          this.receive(message)
        } catch {
          socket.terminate()
        }
      })
      socket.on('close', code => {
        if (!current()) {
          return
        }
        this.socket = undefined
        this.ready = false
        if (rejected || code === 4403) {
          clearInterval(this.deadline)
          this.ssh?.kill()
          this.ssh = undefined
          if (code === 4403) {
            this.status('denied', 'Доступ устройства отозван.')
          }
          return
        }
        this.retry(generation)
      })
    } catch (error) {
      this.retry(generation, error instanceof Error ? error.message : 'Соединение недоступно.')
    }
  }

  private async tunnel(settings: Settings, generation: number): Promise<string> {
    const configured = checkEndpoint(settings.endpoint)
    checkTarget(settings.target, settings.remotePort)
    if (configured.protocol !== 'ws:') {
      throw new Error('Автоматический SSH-туннель использует локальный ws://.')
    }
    const port = await vacantPort()
    if (generation !== this.generation) {
      throw new Error('Подключение отменено.')
    }
    const sshPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh'
    return new Promise((resolve, reject) => {
      const child = spawn(sshPath, ['-v', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UpdateHostKeys=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8',
        '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=2', '-o', 'ControlMaster=no',
        '-o', 'ControlPath=none', '-L', '127.0.0.1:' + port + ':127.0.0.1:' + settings.remotePort,
        '--', settings.target], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      this.ssh = child
      let ready = false
      let log = ''
      const failure = () => new Error('SSH-туннель недоступен. Проверьте SSH-ключ, known_hosts и параметры подключения.')
      const deadline = setTimeout(() => { child.kill(); reject(failure()) }, 11_000)
      child.stderr.on('data', (part: Buffer) => {
        if (ready) {
          return
        }
        log = (log + part.toString()).slice(-4096)
        if (log.includes('Entering interactive session.')) {
          clearTimeout(deadline)
          ready = true
          configured.hostname = '127.0.0.1'
          configured.port = String(port)
          resolve(configured.href)
        }
      })
      child.once('error', () => {
        clearTimeout(deadline)
        reject(failure())
      })
      child.once('exit', () => {
        clearTimeout(deadline)
        if (!ready) {
          reject(failure())
        } else if (generation === this.generation && this.ssh === child) {
          this.socket?.terminate()
        }
      })
    })
  }
}
