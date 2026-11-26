param([switch]$Chat)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Copy desktop/.env.example to desktop/.env and set your VPS address.'
}
$config = @{ BRIDGE_SSH_PORT = '22' }
foreach ($line in Get-Content -LiteralPath $configPath) {
    if ($line -match '^(#.*)?$') { continue }
    if ($line -notmatch '^(BRIDGE_SSH_HOST|BRIDGE_SSH_USER|BRIDGE_SSH_PORT)=([^\s]+)$') {
        throw 'Unexpected entry in desktop/.env.'
    }
    $config[$Matches[1]] = $Matches[2]
}
$sshHost = $config.BRIDGE_SSH_HOST
$sshUser = $config.BRIDGE_SSH_USER
$sshPort = $config.BRIDGE_SSH_PORT
if ($sshHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$|^[0-9a-fA-F]*:[0-9a-fA-F:]+$' -or
    $sshHost -eq '203.0.113.10' -or $sshUser -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$' -or
    $sshPort -notmatch '^[0-9]{1,5}$' -or [int]$sshPort -lt 1 -or [int]$sshPort -gt 65535) {
    throw 'Set BRIDGE_SSH_HOST, BRIDGE_SSH_USER and a valid BRIDGE_SSH_PORT in desktop/.env.'
}

$ssh = Get-Command ssh.exe -CommandType Application
$destination = "$sshUser@$sshHost"
$sshArgs = @(
    '-N', '-T', '-p', $sshPort, '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3'
)
if ($Chat) {
    Write-Host 'Keep this terminal open while using Claude Bridge in VS Code.'
    & $ssh.Source @sshArgs '-L' '127.0.0.1:18765:127.0.0.1:18765' $destination
    exit $LASTEXITCODE
}

$profile = Join-Path $PSScriptRoot 'Claude-Bridge-Desktop.rdp'
$mstsc = Get-Command mstsc.exe -CommandType Application
$desktopPort = 13389
if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) {
    throw 'Claude-Bridge-Desktop.rdp must be next to this script.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $desktopPort -ErrorAction SilentlyContinue) {
    throw 'Port 13389 is already in use. Close the old tunnel first.'
}

$sshArgs += @('-L', '127.0.0.1:13389:127.0.0.1:3389', $destination)
Write-Host 'Enter the SSH password or key passphrase if prompted. Keep that terminal open while using RDP.'
$tunnel = Start-Process -FilePath $ssh.Source -ArgumentList $sshArgs -PassThru
$deadline = (Get-Date).AddMinutes(2)
try {
    do {
        if ($tunnel.HasExited) { throw 'SSH exited before the tunnel was ready.' }
        $listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $desktopPort -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $tunnel.Id }
        if ($listener) {
            Start-Process -FilePath $mstsc.Source -ArgumentList ('"{0}"' -f $profile)
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'SSH tunnel did not start within two minutes.'
} catch {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
    throw
}
