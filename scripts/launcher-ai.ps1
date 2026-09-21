#Requires -Version 5.1
# Imported helpers only. AI configuration failures never restart or stop the API.

function Remove-AiProcessEnvironment {
    $saved = @{}
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ($name -match '^(AI_|OPENAI_)') {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
    return $saved
}

function Restore-AiProcessEnvironment([hashtable]$Saved) {
    foreach ($name in $Saved.Keys) { [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process') }
}

function Get-AiLocalPaths([string]$Root, [string]$PrivateDirectory) {
    return @{
        Vars = (Join-Path $Root 'worker/.dev.vars')
        Tick = (Join-Path $PrivateDirectory 'ai-tick-token.dpapi')
        RootKey = (Join-Path $PrivateDirectory 'ai-encryption-key.dpapi')
        Marker = (Join-Path $PrivateDirectory 'ai-encryption-initialized.json')
    }
}

function Assert-AiLocalPaths([string]$Root, [string]$PrivateDirectory, $Paths) {
    Initialize-PrivateDirectory $PrivateDirectory
    if ((Get-Item -LiteralPath (Join-Path $Root 'worker') -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The Worker directory must not be a link.' }
    foreach ($file in $Paths.Values) {
        Assert-SecretPathIgnored $Root $file
        if (Test-Path -LiteralPath $file) { Set-PrivateFileAccess $file }
    }
}

function Write-AiDevVariables([string]$Root, [string]$PrivateDirectory, [hashtable]$Values) {
    $paths = Get-AiLocalPaths $Root $PrivateDirectory
    Assert-AiLocalPaths $Root $PrivateDirectory $paths
    $source = if (Test-Path -LiteralPath $paths.Vars) { [IO.File]::ReadAllText($paths.Vars) } else { '' }
    $next = $source
    foreach ($name in $Values.Keys | Sort-Object) {
        $configured = Get-DevVariable $source $name
        if ($null -ne $configured -and $configured -cne $Values[$name]) { throw 'AI configuration differs from its encrypted recovery file; both were preserved.' }
        if ($null -eq $configured) {
            if ($next.Length -gt 0 -and -not $next.EndsWith("`n")) { $next += "`n" }
            $next += $name + '=' + (ConvertTo-DotEnvValue $Values[$name]) + "`n"
        }
    }
    if ($next -ceq $source) { return }
    $staged = Join-Path $PrivateDirectory ('ai-vars-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($staged, $next, (New-Object Text.UTF8Encoding($false)))
        Set-PrivateFileAccess $staged
        $current = if (Test-Path -LiteralPath $paths.Vars) { [IO.File]::ReadAllText($paths.Vars) } else { '' }
        if ($current -cne $source) { throw 'Worker configuration changed during AI preparation; no replacement was made.' }
        if (Test-Path -LiteralPath $paths.Vars) { [IO.File]::Replace($staged, $paths.Vars, [NullString]::Value) }
        else { [IO.File]::Move($staged, $paths.Vars) }
        Set-PrivateFileAccess $paths.Vars
    } finally { if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force } }
}

function Assert-AiEncryptionKey([string]$Value) {
    try { $bytes = [Convert]::FromBase64String($Value) } catch { throw 'The AI encryption key must be 32 bytes in standard base64.' }
    if ($bytes.Length -ne 32 -or [Convert]::ToBase64String($bytes) -cne $Value) { throw 'The AI encryption key must be 32 bytes in standard base64.' }
}

function Save-AiInitializationMarker([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Set-PrivateFileAccess $Path; return }
    $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes('{"initialized":true,"version":1}'); $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) }
    finally { $file.Dispose() }
    Set-PrivateFileAccess $Path
}

function Initialize-AiLocalConfiguration([string]$Root, [string]$PrivateDirectory) {
    $paths = Get-AiLocalPaths $Root $PrivateDirectory
    Assert-AiLocalPaths $Root $PrivateDirectory $paths
    $source = if (Test-Path -LiteralPath $paths.Vars) { [IO.File]::ReadAllText($paths.Vars) } else { '' }
    $configuredTick = Get-DevVariable $source 'AI_TICK_TOKEN'
    $token = if (Test-Path -LiteralPath $paths.Tick) { Read-LocalPassword $paths.Tick } elseif ($null -ne $configuredTick) { $configuredTick } else { New-LocalPassword }
    if ($token.Length -lt 32 -or $token -match '[\r\n\x00]') { throw 'The AI tick token must be at least 32 characters without line breaks.' }
    if ($null -ne $configuredTick -and $configuredTick -cne $token) { throw 'The AI tick configuration differs from its recovery file; both were preserved.' }
    if (-not (Test-Path -LiteralPath $paths.Tick)) { Save-LocalPassword $paths.Tick $token }
    Write-AiDevVariables $Root $PrivateDirectory @{ AI_TICK_TOKEN = $token }
    $result = [pscustomobject]@{ Token = $token; RootAvailable = $false; BootstrapAllowed = $false; Status = 'encryption-unavailable' }
    try {
        $configuredRoot = Get-DevVariable $source 'AI_CREDENTIAL_ENCRYPTION_KEY'
        $rootKey = if (Test-Path -LiteralPath $paths.RootKey) { Read-LocalPassword $paths.RootKey } else { $configuredRoot }
        if ($null -ne $rootKey) {
            Assert-AiEncryptionKey $rootKey
            if ($null -ne $configuredRoot -and $configuredRoot -cne $rootKey) { throw 'AI root recovery mismatch.' }
            if (-not (Test-Path -LiteralPath $paths.RootKey)) { Save-LocalPassword $paths.RootKey $rootKey }
            Save-AiInitializationMarker $paths.Marker
            Write-AiDevVariables $Root $PrivateDirectory @{ AI_CREDENTIAL_ENCRYPTION_KEY = $rootKey }
            $result.RootAvailable = $true
            $result.Status = 'awaiting-runtime-check'
        } elseif (-not (Test-Path -LiteralPath $paths.Marker)) {
            $result.BootstrapAllowed = $true
            $result.Status = 'awaiting-bootstrap-check'
        }
    } catch { $result.Status = 'encryption-recovery-required' }
    return $result
}

function Assert-AiApiOwnership {
    $supervisor = Get-VerifiedApiSupervisor
    if (-not $supervisor -or $supervisor.ProcessId -ne $PID) { throw 'AI tick destination is not owned by this API supervisor; no credential was sent.' }
}

function Get-AiBootstrapState([string]$Token) {
    Assert-AiApiOwnership
    $reply = Invoke-LocalApi 'http://127.0.0.1:8787' '/api/internal/translations/bootstrap' 'GET' $null '' $Token 5
    if ($reply.Status -ne 200 -or $reply.Json.initialized -isnot [bool] -or $reply.Json.hasCredential -isnot [bool] -or $reply.Json.encryptionReady -isnot [bool]) { throw 'AI bootstrap state is unavailable; no encryption key was generated.' }
    return $reply.Json
}

function Complete-AiBootstrap([string]$Root, [string]$PrivateDirectory, $Configuration) {
    $state = Get-AiBootstrapState $Configuration.Token
    if (-not $Configuration.RootAvailable) {
        if (-not $Configuration.BootstrapAllowed -or $state.initialized -or $state.hasCredential -or $state.encryptionReady) {
            $Configuration.BootstrapAllowed = $false
            $Configuration.Status = 'encryption-recovery-required'
            return $false
        }
        $paths = Get-AiLocalPaths $Root $PrivateDirectory
        Assert-AiLocalPaths $Root $PrivateDirectory $paths
        # Recheck disk immediately before generation. A recovery file is never replaced.
        if ((Test-Path -LiteralPath $paths.RootKey) -or (Test-Path -LiteralPath $paths.Marker) -or $null -ne (Get-DevVariable ([IO.File]::ReadAllText($paths.Vars)) 'AI_CREDENTIAL_ENCRYPTION_KEY')) { throw 'AI recovery state changed during bootstrap; no replacement key was generated.' }
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $rootKey = [Convert]::ToBase64String($bytes)
        Save-LocalPassword $paths.RootKey $rootKey
        Save-AiInitializationMarker $paths.Marker
        Write-AiDevVariables $Root $PrivateDirectory @{ AI_CREDENTIAL_ENCRYPTION_KEY = $rootKey }
        $Configuration.RootAvailable = $true
        $Configuration.BootstrapAllowed = $false
        # .dev.vars writes may reload Wrangler, but only its actual reply proves it.
        $state = Get-AiBootstrapState $Configuration.Token
    }
    $Configuration.Status = if ($state.encryptionReady) { 'ready' } else { 'awaiting-normal-api-restart' }
    return [bool]$state.encryptionReady
}

function Invoke-AiTranslationTick([string]$Token) {
    Assert-AiApiOwnership
    $reply = Invoke-LocalApi 'http://127.0.0.1:8787' '/api/internal/translations/tick' 'POST' $null '' $Token 55
    if ($reply.Status -ne 200) { throw 'AI translation tick is unavailable; the website API remains running.' }
    return $reply.Json
}

function Start-ApiChild {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $cli = Join-Path (Split-Path -Parent $npm) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'The npm CLI beside npm.cmd was not found.' }
    Initialize-PrivateDirectory $LocalDir
    $logId = 'api-child-' + [Guid]::NewGuid().ToString('N')
    $aiEnvironment = Remove-AiProcessEnvironment
    # Wrangler reads the private .dev.vars bindings; they are not shell arguments.
    # Explicit file handles preserve npm/Worker output when there is no console.
    try {
        $child = Microsoft.PowerShell.Management\Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source -ArgumentList ('"' + $cli + '" run dev -- --ip 127.0.0.1 --port 8787') -WorkingDirectory (Join-Path $RepoRoot 'worker') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LocalDir ($logId + '.out.log')) -RedirectStandardError (Join-Path $LocalDir ($logId + '.err.log')) -PassThru
        # WinPS Start-Process needs its handle retained to observe the real exit code.
        [void]$child.Handle
        return $child
    } finally { Restore-AiProcessEnvironment $aiEnvironment }
}

function Wait-ApiChild($Child, [int]$Milliseconds) { return $Child.WaitForExit($Milliseconds) }
function Get-AiTickTime { return [DateTime]::UtcNow }

function Invoke-ApiSession($Configuration) {
    # A surviving child or another instance may still own the port after npm exits.
    # Reuse the launcher ownership check; never replace or stop an occupied listener.
    if (@(Get-OwnedListener (Get-ServiceDefinition 'api')).Count -gt 0) { throw 'The API port is still occupied; no replacement child was started.' }
    $child = Start-ApiChild
    $nextTick = Get-AiTickTime
    $lastStatus = ''
    try {
        while (-not (Wait-ApiChild $child 1000)) {
            $now = Get-AiTickTime
            if ($null -eq $configuration -or $now -lt $nextTick) { continue }
            $nextTick = $now.AddSeconds(60)
            try {
                if ($configuration.Status -ceq 'ready' -or (Complete-AiBootstrap $RepoRoot $LocalDir $configuration)) {
                    [void](Invoke-AiTranslationTick $configuration.Token)
                    $status = 'ready'
                } else { $status = $configuration.Status }
            } catch { $status = 'temporarily-unavailable' }
            if ($status -cne $lastStatus) {
                Write-Host ('[ai] ' + $status + '; website supervision continues.')
                $lastStatus = $status
            }
        }
        if ($child.ExitCode -ne 0) { throw "npm failed in the API service (exit $($child.ExitCode))." }
    } finally { $child.Dispose() }
}

function Invoke-ApiSupervisor {
    $configuration = $null
    try { $configuration = Initialize-AiLocalConfiguration $RepoRoot $LocalDir }
    catch { Write-Warning 'AI configuration preparation failed; existing credentials were preserved. Website startup continues.' }
    $delay = 3
    while ($true) {
        $startedAt = Get-AiTickTime
        try { Invoke-ApiSession $configuration; Write-Host '[api] API child exited; restarting.' }
        catch { Write-Warning ('API child stopped: ' + $_.Exception.Message) }
        if (((Get-AiTickTime) - $startedAt).TotalSeconds -ge 60) { $delay = 3 }
        Write-Host "[api] Restart in $delay seconds."
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min(30, $delay * 2)
    }
}
