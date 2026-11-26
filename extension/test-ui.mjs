import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const project = process.env.BRIDGE_TEST_PROJECT
const debug = process.env.BRIDGE_TEST_CDP
if (!project || !debug) {
  throw new Error('Set BRIDGE_TEST_PROJECT and BRIDGE_TEST_CDP for an isolated VS Code instance.')
}

async function input() {
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
  }
  return JSON.parse(data)
}

const { token, id } = await input()
const marker = 'bridge-sentinel-' + Date.now()
const baseline = 'sample line\nsearch needle\n'
const fixture = path.join(project, 'sample.txt')
const created = path.join(project, 'created.txt')
const shellFile = path.join(project, 'command.txt')
const privateFile = path.join(project, '..', 'private-fixture.txt')
await access(path.join(project, '.claude-bridge-test-workspace'))
await rm(created, { force: true })
await rm(shellFile, { force: true })
await writeFile(fixture, baseline)
await writeFile(path.join(project, '.env'), 'PRIVATE_FIXTURE_ONLY\n')
await writeFile(privateFile, 'OUTSIDE_WORKSPACE_ONLY\n')
await symlink(privateFile, path.join(project, 'outside-link.txt')).catch(error => {
  if (error.code !== 'EEXIST') throw error
})
const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' })
git('init', '-q')
git('add', 'sample.txt')
git('-c', 'user.name=Bridge Test', '-c', 'user.email=bridge@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
await writeFile(fixture, baseline + 'local git change\n')

const browser = await chromium.connectOverCDP(debug)
const page = browser.contexts()[0].pages()[0]
const bridgeTab = page.getByRole('tab', { name: 'Claude Bridge' })
const chat = page.frameLocator('iframe.webview').frameLocator('iframe#active-frame')
const wait = { timeout: 14_000 }
const get = id => chat.locator('#' + id)
const quickInput = page.locator('.quick-input-widget:visible input')
const commandModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function command(label) {
  await page.keyboard.press(commandModifier + '+Shift+p')
  await quickInput.fill('>' + label, wait)
  await quickInput.press('Enter')
}
async function online() {
  await chat.locator('#status[data-state=online]').waitFor(wait)
}
async function revealPanel() {
  const visible = await get('status').waitFor({ timeout: 1500 }).then(() => true, () => false)
  if (!visible) {
    await bridgeTab.click(wait)
    await get('status').waitFor(wait)
  }
}
async function status(value) {
  await chat.locator('#status[data-state=' + value + ']').waitFor(wait)
}
async function configure() {
  if (await get('configure').isVisible()) {
    await get('configure').click(wait)
  } else {
    await command('Claude Bridge: Подключить устройство')
  }
  const pass = page.locator('.quick-input-widget:visible input[type=password]')
  await pass.fill(token, wait)
  await pass.press('Enter')
  await revealPanel()
  await online()
}
async function send(text, tools = false) {
  await get('allow').setChecked(tools)
  await get('prompt').fill(text)
  const responses = await chat.locator('#history .assistant').count()
  await get('send').click(wait)
  return responses + 1
}
function recipe(...calls) {
  return '/mock ' + JSON.stringify(calls.map(([name, args = {}]) => ({ name, arguments: args })))
}
async function completed(count) {
  const result = chat.locator('#history .assistant').nth(count - 1)
  await result.waitFor(wait)
  return result.innerText()
}
async function approve(action, accepted = true) {
  await get('approval-title').getByText(action, { exact: false }).waitFor(wait)
  await get(accepted ? 'accept' : 'reject').click(wait)
}
async function absent(file) {
  await assert.rejects(access(file), { code: 'ENOENT' })
}

try {
  await revealPanel()
  const tooltip = chat.getByRole('tooltip')
  if (await get('new').isDisabled()) {
    await get('new').locator('..').hover(wait)
    await tooltip.getByText('Подключите сервер', { exact: false }).waitFor(wait)
  }
  await configure()
  await get('new').hover(wait)
  await tooltip.getByText('Новый диалог', { exact: false }).waitFor(wait)
  await get('scroll').hover(wait)
  await get('selection').focus(wait)
  await tooltip.getByText('Сначала выделите код', { exact: false }).waitFor(wait)
  assert.equal(await get('selection').getAttribute('aria-describedby'), 'tooltip')
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden', ...wait })
  assert.equal(await get('selection').getAttribute('aria-describedby'), null)
  console.log('Icon explanations appear on hover and keyboard focus, and dismiss with Escape')
  await get('turn').evaluate(element => {
    const deltas = globalThis.bridgeTestDeltas = []
    new MutationObserver(() => {
      const content = element.querySelector('.assistant .message-body')?.textContent
      if (content) deltas.push(content)
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })
  let count = await send(marker)
  assert.match(await completed(count), /MockProvider на связи/)
  const deltas = await get('turn').evaluate(() => new Set(globalThis.bridgeTestDeltas).size)
  assert.ok(deltas >= 2)
  console.log('VSIX sidebar, device sign-in, streaming chat and Markdown rendered')

  count = await send(recipe(
    ['list_directory'], ['read_file', { path: 'sample.txt', start_line: 2, end_line: 2 }],
    ['search_files', { query: 'sample' }], ['search_content', { query: 'search needle' }],
    ['read_file', { path: '.env' }], ['read_file', { path: '../private-fixture.txt' }],
    ['read_file', { path: 'outside-link.txt' }], ['git_status'],
  ), true)
  let answer = await completed(count)
  assert.match(answer, /search needle/)
  assert.match(answer, /search_files · готово/)
  assert.match(answer, /search_content · готово/)
  assert.match(answer, /list_directory · готово/)
  assert.match(answer, /git_status · готово/)
  assert.equal([...answer.matchAll(/read_file · ошибка/g)].length, 3)
  assert.doesNotMatch(answer, /OUTSIDE_WORKSPACE_ONLY|PRIVATE_FIXTURE_ONLY/)
  console.log('Read, list, search, Git status, traversal, symlink and sensitive path coverage')

  count = await send(recipe(['git_diff']), true)
  answer = await completed(count)
  assert.match(answer, /git_diff · готово/)
  assert.match(answer, /local git change/)

  count = await send(recipe(
    ['create_file', { path: 'created.txt', content: 'first version\n' }],
    ['edit_file', { path: 'created.txt', content: 'rejected version\n' }],
  ), true)
  await get('approval').waitFor(wait)
  await page.locator('.tabs-container .tab').filter({ hasText: 'Claude Bridge · created.txt' }).first().waitFor(wait)
  await absent(created)
  await approve('Создать файл')
  await approve('Применить изменение', false)
  answer = await completed(count)
  assert.match(answer, /create_file · готово/)
  assert.match(answer, /edit_file · ошибка/)
  assert.equal(await readFile(created, 'utf8'), 'first version\n')

  count = await send(recipe(
    ['edit_file', { path: 'created.txt', content: 'approved version\n' }],
    ['apply_patch', { path: 'created.txt', patch: '--- a/created.txt\n+++ b/created.txt\n@@ -1 +1 @@\n-approved version\n+patched version\n' }],
    ['delete_file', { path: 'created.txt' }],
  ), true)
  await approve('Применить изменение')
  await get('approval').waitFor(wait)
  assert.equal(await readFile(created, 'utf8'), 'approved version\n')
  await approve('Применить изменение')
  await approve('Удалить файл', false)
  answer = await completed(count)
  assert.match(answer, /apply_patch · готово/)
  assert.match(answer, /delete_file · ошибка/)
  assert.equal(await readFile(created, 'utf8'), 'patched version\n')

  count = await send(recipe(['delete_file', { path: 'created.txt' }]), true)
  await approve('Удалить файл')
  assert.match(await completed(count), /delete_file · готово/)
  await absent(created)
  console.log('VS Code Diff, accepted create/edit/patch/delete and rejected edit/delete')

  const command = process.platform === 'win32' ? 'Set-Content command.txt terminal-ok' : 'printf terminal-ok > command.txt'
  count = await send(recipe(['run_command', { command }], ['run_command', { command }]), true)
  await get('approval-detail').getByText(command, { exact: true }).waitFor(wait)
  await absent(shellFile)
  await approve('Выполнить команду', false)
  await get('approval-detail').getByText(command, { exact: true }).waitFor(wait)
  await absent(shellFile)
  await approve('Выполнить команду')
  answer = await completed(count)
  assert.match(answer, /run_command · ошибка/)
  assert.match(answer, /run_command · готово/)
  assert.equal((await readFile(shellFile, 'utf8')).trim(), 'terminal-ok')
  console.log('Command denied, then confirmed and executed in the selected workspace')

  const started = await send(recipe(['delete_file', { path: 'sample.txt' }]), true)
  await get('approval').waitFor(wait)
  await get('stop').click(wait)
  await get('notice').getByText('Генерация остановлена', { exact: false }).waitFor(wait)
  assert.equal(await chat.locator('#history .assistant').count(), started - 1)
  assert.match(await readFile(fixture, 'utf8'), /search needle/)
  console.log('Cancellation discarded the pending, unapproved operation')

  const dialog = await get('dialogs').inputValue()
  await get('new').click(wait)
  await chat.locator('#empty').waitFor(wait)
  await get('dialogs').selectOption(dialog)
  await chat.locator('#history .user').getByText(marker, { exact: true }).waitFor(wait)
  console.log('Multiple dialogs and history retrieval')

  await get('attach').click(wait)
  await quickInput.fill(fixture, wait)
  await quickInput.press('Enter')
  await get('attachments').getByText('sample.txt', { exact: true }).waitFor(wait)
  await chat.getByRole('button', { name: 'Убрать вложение: sample.txt' }).hover(wait)
  await tooltip.getByText('Убрать это вложение', { exact: false }).waitFor(wait)
  count = await send('Проверка вложения')
  assert.match(await completed(count), /Локальный контекст получен/)
  await get('attachments').waitFor({ state: 'hidden', ...wait })

  await page.keyboard.press(commandModifier + '+p')
  await quickInput.fill('sample.txt', wait)
  await page.locator('.quick-input-widget:visible').getByText('sample.txt', { exact: true }).first().waitFor(wait)
  await quickInput.press('Enter')
  await quickInput.waitFor({ state: 'hidden', ...wait })
  await page.locator('.tabs-container .tab[aria-label="sample.txt"]').click(wait)
  await page.locator('.tabs-container .tab.active[aria-label="sample.txt"]').waitFor(wait)
  await page.locator('.editor-group-container.active .view-lines').getByText('sample line', { exact: true }).click(wait)
  await page.keyboard.press(commandModifier + '+a')
  await get('selection').click(wait)
  await get('attachments').getByText('sample.txt · выделение', { exact: true }).waitFor(wait)
  count = await send(recipe(['get_active_editor'], ['get_selected_text'], ['get_diagnostics', { path: 'sample.txt' }]), true)
  answer = await completed(count)
  assert.match(answer, /get_active_editor · готово/)
  assert.match(answer, /get_selected_text · готово/)
  assert.match(answer, /search needle/)
  assert.match(answer, /get_diagnostics · готово/)
  console.log('File picker, selected text, editor context and diagnostics')

  if (process.env.BRIDGE_TEST_SSH_CONTROL && process.env.BRIDGE_TEST_SSH_TARGET) {
    const ssh = (code) => execFileSync('ssh', ['-S', process.env.BRIDGE_TEST_SSH_CONTROL,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', process.env.BRIDGE_TEST_SSH_TARGET, code], { stdio: 'ignore' })
    const sawDisconnect = get('status').evaluate(element => new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (element.dataset.state !== 'online') { observer.disconnect(); resolve(true) }
      })
      observer.observe(element, { attributes: true, attributeFilter: ['data-state'] })
      setTimeout(() => { observer.disconnect(); resolve(false) }, 12_000)
    }))
    // The stop and start affect only the application’s service, and guarantee a visible outage.
    ssh('systemctl restart claude-bridge.service')
    assert.ok(await sawDisconnect)
    await online()
    await chat.locator('#history .user').getByText(marker, { exact: true }).waitFor(wait)
    count = await send('Проверка после перезапуска')
    assert.match(await completed(count), /MockProvider на связи/)
    console.log('VPS service restart, automatic WebSocket reconnection and retained history')

    if (process.env.BRIDGE_TEST_REVOKE === '1' && /^[a-f0-9]{16}$/.test(id)) {
      ssh('/opt/claude-bridge/admin revoke ' + id)
      await status('denied')
      console.log('Device revocation terminates the active VS Code session')
    }
  }
} catch (error) {
  console.error(String(error.stack ?? error).replace(/cb_[A-Za-z0-9_-]{43}/g, '[credential]'))
  process.exitCode = 1
} finally {
  await browser.close()
}
