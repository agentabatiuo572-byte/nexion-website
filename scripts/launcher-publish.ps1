#Requires -Version 5.1
# Loaded by start-website.ps1. No service or credential side effects on import.

function Assert-SecretPathIgnored([string]$Root, [string]$Path) {
    & (Get-Command git.exe -ErrorAction Stop).Source -C $Root check-ignore --quiet -- $Path
    if ($LASTEXITCODE -ne 0) { throw "Private credential path is not ignored by Git: $Path. No plaintext secret was written." }
}

function Set-PrivateFileAccess([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The private file must not be a link.' }
    $acl = New-Object Security.AccessControl.FileSecurity
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
    }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
    else { $item.SetAccessControl($acl) }
}

function Get-DevVariable([string]$Text, [string]$Name) {
    $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [regex]::Escape($Name) + '[ \t]*=[ \t]*(.*?)[ \t]*\r?$'
    $matches = [regex]::Matches($Text, $pattern)
    if ($matches.Count -gt 1) { throw "Duplicate $Name entries in worker/.dev.vars; the file was preserved." }
    if ($matches.Count -eq 0) { return $null }
    $value = $matches[0].Groups[1].Value.Trim()
    if ($value.StartsWith('"')) {
        $quoted = [regex]::Match($value, '^"((?:\\.|[^"\\])*)"[ \t]*(?:#.*)?$')
        if (-not $quoted.Success) { throw "Unsupported quoted $Name in worker/.dev.vars; the file was preserved." }
        # dotenv expands only newline/carriage-return escapes in double quotes.
        return $quoted.Groups[1].Value.Replace('\n', "`n").Replace('\r', "`r")
    }
    if ($value.StartsWith("'")) {
        $quoted = [regex]::Match($value, "^'([^']*)'[ \t]*(?:#.*)?$")
        if (-not $quoted.Success) { throw "Unsupported quoted $Name in worker/.dev.vars." }
        return $quoted.Groups[1].Value
    }
    if ($value.StartsWith([string][char]96)) {
        $quoted = [regex]::Match($value, '^`([^`]*)`[ \t]*(?:#.*)?$')
        if (-not $quoted.Success) { throw "Unsupported quoted $Name in worker/.dev.vars." }
        return $quoted.Groups[1].Value
    }
    return (($value -split '#', 2)[0]).Trim()
}

function ConvertTo-DotEnvValue([string]$Value) {
    foreach ($character in @(39, 96, 34)) {
        $quote = [string][char]$character
        if ($Value.Contains($quote)) { continue }
        $candidate = $quote + $Value + $quote
        try { if ((Get-DevVariable ('VALUE=' + $candidate) 'VALUE') -ceq $Value) { return $candidate } } catch { }
    }
    throw 'The existing secret cannot be represented losslessly in dotenv; its encrypted copy was preserved.'
}

function Initialize-PublishConfiguration([string]$Root, [string]$PrivateDirectory) {
    $varsPath = Join-Path $Root 'worker/.dev.vars'
    $secretPath = Join-Path $PrivateDirectory 'publish-runner-token.dpapi'
    Assert-SecretPathIgnored $Root $varsPath
    Assert-SecretPathIgnored $Root $secretPath
    Initialize-PrivateDirectory $PrivateDirectory
    if ((Get-Item -LiteralPath (Join-Path $Root 'worker') -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The worker directory must not be a link.' }
    $source = ''
    if (Test-Path -LiteralPath $varsPath) {
        Set-PrivateFileAccess $varsPath
        $source = [IO.File]::ReadAllText($varsPath)
    }
    $configured = Get-DevVariable $source 'PUBLISH_RUNNER_TOKEN'
    $mode = Get-DevVariable $source 'PUBLISH_EXECUTION_MODE'
    if ($null -ne $mode -and $mode -ne 'local') { throw 'worker/.dev.vars selects another publish mode. Its configuration was preserved.' }
    if (Test-Path -LiteralPath $secretPath) {
        $token = Read-LocalPassword $secretPath
        if ($null -ne $configured -and $configured -cne $token) { throw 'The saved publish secret differs from worker/.dev.vars. Both were preserved; restore the matching configuration.' }
    } else {
        $token = if ($null -ne $configured) { $configured } else { New-LocalPassword }
    }
    if ($token.Length -lt 32 -or $token -match '[\r\n\x00]') { throw 'The publish secret must contain at least 32 characters and no line breaks.' }
    if (-not (Test-Path -LiteralPath $secretPath)) { Save-LocalPassword $secretPath $token }
    $next = $source
    if ($null -eq $configured) {
        if ($next.Length -gt 0 -and -not $next.EndsWith("`n")) { $next += "`n" }
        $next += 'PUBLISH_RUNNER_TOKEN=' + (ConvertTo-DotEnvValue $token) + "`n"
    }
    if ($null -eq $mode) {
        if ($next.Length -gt 0 -and -not $next.EndsWith("`n")) { $next += "`n" }
        $next += "PUBLISH_EXECUTION_MODE=local`n"
    }
    if ($next -cne $source) {
        # Stage under the protected directory, apply an explicit private ACL, then
        # atomically move/replace. A plaintext file is never created with public ACLs.
        $staged = Join-Path $PrivateDirectory ('publish-vars-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllText($staged, $next, (New-Object Text.UTF8Encoding($false)))
            Set-PrivateFileAccess $staged
            if (Test-Path -LiteralPath $varsPath) { [IO.File]::Replace($staged, $varsPath, [NullString]::Value) }
            else { [IO.File]::Move($staged, $varsPath) }
            Set-PrivateFileAccess $varsPath
        } finally { if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force } }
    }
    return [pscustomobject]@{ Token = $token; Changed = ($next -cne $source) }
}

function Get-LauncherMutexName([string]$Name) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($RepoRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    return "Local\NexGridSupervisor-$key-$Name"
}

function Test-LauncherProcess($Process, [string]$Name) {
    if ($null -eq $Process -or -not $Process.CommandLine) { return $false }
    $parts = @([regex]::Matches([string]$Process.CommandLine, '(?:[^\s"]+|"[^"]*")+') | ForEach-Object { $_.Value.Trim('"') })
    if ($parts.Count -lt 5 -or [IO.Path]::GetFileName($parts[0]) -notin @('powershell.exe', 'powershell')) { return $false }
    $index = 1
    while ($index -lt $parts.Count -and $parts[$index] -ine '-File') {
        if ($parts[$index] -in @('-NoLogo', '-NoProfile', '-NonInteractive')) { $index++; continue }
        if ($parts[$index] -ieq '-ExecutionPolicy' -and $index + 1 -lt $parts.Count -and $parts[$index + 1] -ieq 'Bypass') { $index += 2; continue }
        # -Command / -EncodedCommand consume later tokens as data, so merely
        # finding a trailing -File argument cannot prove executable ownership.
        return $false
    }
    if ($index + 4 -ne $parts.Count) { return $false }
    return $parts[$index + 1] -ieq $LauncherPath -and $parts[$index + 2] -ieq '-Service' -and $parts[$index + 3] -ceq $Name
}

function Save-SupervisorRecord([string]$Name, $Process) {
    $recordPath = Join-Path $LocalDir "$Name-process.json"
    $staging = Join-Path $LocalDir ($Name + '-process-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $body = @{ ProcessId = $Process.ProcessId; Created = $Process.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json
        [IO.File]::WriteAllText($staging, $body, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $recordPath) { [IO.File]::Replace($staging, $recordPath, [NullString]::Value) }
        else { [IO.File]::Move($staging, $recordPath) }
    } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force } }
}

function Recover-SupervisorRecord([string]$Name) {
    # A damaged/absent PID is never termination authority. Rediscover only the
    # full canonical launcher command; each supervisor also holds an OS mutex.
    $matches = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop | Where-Object { Test-LauncherProcess $_ $Name })
    if ($matches.Count -gt 1) { throw "Multiple matching $Name supervisors; no process was stopped." }
    $recordPath = Join-Path $LocalDir "$Name-process.json"
    if (Test-Path -LiteralPath $recordPath) {
        [IO.File]::Move($recordPath, $recordPath + '.invalid-' + [Guid]::NewGuid().ToString('N'))
    }
    if ($matches.Count -eq 1) { Save-SupervisorRecord $Name $matches[0]; return $matches[0] }
    return $null
}

function Get-OwnedSupervisor([string]$Name) {
    $recordPath = Join-Path $LocalDir "$Name-process.json"
    if (-not (Test-Path -LiteralPath $recordPath)) { return Recover-SupervisorRecord $Name }
    if ((Get-Item -LiteralPath $recordPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The process record must not be a link.' }
    try { $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json } catch { return Recover-SupervisorRecord $Name }
    $recordPid = 0
    try {
        if (-not [int]::TryParse([string]$record.ProcessId, [ref]$recordPid) -or $recordPid -le 0 -or -not $record.Created) { return Recover-SupervisorRecord $Name }
        $recordCreated = ([DateTime]$record.Created).ToUniversalTime()
    } catch { return Recover-SupervisorRecord $Name }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.ProcessId)" -ErrorAction Stop
    if (-not $process) { return $null }
    if (-not (Test-LauncherProcess $process $Name)) { return $null }
    if ($process.CreationDate.ToUniversalTime() -ne $recordCreated) { return $null }
    return $process
}

function Start-LocalSupervisor([string]$Name) {
    if (Get-OwnedSupervisor $Name) { Write-Host "[reuse] $Name supervisor"; return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$LauncherPath`" -Service $Name"
    $started = Start-Process -FilePath $WindowsPowerShell -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LocalDir "$Name-$stamp.out.log") -RedirectStandardError (Join-Path $LocalDir "$Name-$stamp.err.log") -PassThru
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Id)" -ErrorAction Stop
    if (-not $process -or -not (Test-LauncherProcess $process $Name)) { throw "The $Name supervisor exited before its identity could be saved." }
    Save-SupervisorRecord $Name $process
    Write-Host "[start] $Name supervisor"
}

function Get-ProcessBranch($RootProcess) {
    $result = New-Object 'Collections.Generic.List[object]'
    $pending = New-Object 'Collections.Generic.Queue[object]'
    $pending.Enqueue($RootProcess)
    while ($pending.Count -gt 0) {
        $parent = $pending.Dequeue()
        $result.Add($parent)
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.ProcessId)" -ErrorAction Stop)) {
            if ($child.CreationDate.ToUniversalTime() -lt $parent.CreationDate.ToUniversalTime()) { throw 'A process parent identity was reused; no service was stopped.' }
            if ($result.ProcessId -contains $child.ProcessId) { throw 'Invalid process tree; no service was stopped.' }
            $pending.Enqueue($child)
        }
    }
    return $result.ToArray()
}

function Stop-VerifiedProcess($Expected) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.ProcessId)" -ErrorAction Stop
    if (-not $current) { return }
    if ($current.CreationDate.ToUniversalTime() -ne $Expected.CreationDate.ToUniversalTime() -or $current.CommandLine -cne $Expected.CommandLine -or $current.ParentProcessId -ne $Expected.ParentProcessId) {
        throw 'Process identity changed before restart; the replacement process was NOT stopped.'
    }
    Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
}

function Get-VerifiedApiSupervisor {
    $definition = Get-ServiceDefinition 'api'
    $listeners = @(Get-OwnedListener $definition)
    if ($listeners.Count -eq 0) { return $null }
    $supervisor = Get-OwnedSupervisor 'api'
    if (-not $supervisor) { throw 'API ownership is not proven by a live launcher supervisor; no process was stopped.' }
    $roots = @{}
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
        if (-not $process -or -not (Test-ServiceCommandPath $process.CommandLine $definition.Marker)) { throw 'API ownership changed; no service was stopped.' }
        $root = $null
        $parent = $process
        # Walk only parents with a matching lifetime. A global npm/terminal process
        # is never selected merely because one of its descendants is this API.
        while ($parent.ParentProcessId -gt 0) {
            $next = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)" -ErrorAction Stop
            if (-not $next -or $next.CreationDate.ToUniversalTime() -gt $parent.CreationDate.ToUniversalTime()) { break }
            if ($supervisor -and $next.ProcessId -eq $supervisor.ProcessId -and $next.CreationDate -eq $supervisor.CreationDate) { $root = $next; break }
            $parent = $next
        }
        if (-not $root) { throw 'API listener is not a descendant of the verified launcher supervisor; no process was stopped.' }
        $roots[[string]$root.ProcessId] = $root
    }
    return $supervisor
}

function Stop-OwnedApi {
    $definition = Get-ServiceDefinition 'api'
    $supervisor = Get-VerifiedApiSupervisor
    if (-not $supervisor) { return }
    $branches = @(Get-ProcessBranch $supervisor)
    # All roots and descendants are captured before the first stop. Recheck each
    # PID's creation time immediately before terminating it, never taskkill by PID.
    $seen = @{}
    foreach ($process in $branches) {
        if (-not $seen.ContainsKey([string]$process.ProcessId)) {
            Stop-VerifiedProcess $process
            $seen[[string]$process.ProcessId] = $true
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (@(Get-OwnedListener $definition).Count -gt 0) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The owned API did not stop. Restart was aborted.' }
        Start-Sleep -Milliseconds 250
    }
}

function Get-PublishRunnerState([string]$Token) {
    if (@(Get-OwnedListener (Get-ServiceDefinition 'api')).Count -eq 0) { throw 'The local API is not running.' }
    if (-not (Get-VerifiedApiSupervisor)) { throw 'API supervisor ownership could not be verified; no credential was sent.' }
    $reply = Invoke-LocalApi 'http://127.0.0.1:8787' '/api/publish/runner-state' 'GET' $null '' $Token
    if ($reply.Status -ne 200 -or $reply.Json.environment -ne 'dev' -or $reply.Json.executor.mode -ne 'local') { throw 'The local API has not loaded the publish executor configuration.' }
    return $reply.Json
}

function Ensure-PublishApi([string]$Token) {
    try { [void](Get-PublishRunnerState $Token); return } catch { }
    Write-Host '[reload] Loading the local publish configuration into the owned API'
    Stop-OwnedApi
    Ensure-LocalService 'api'
    # A successful HTTP health check alone cannot prove the secret was loaded.
    [void](Get-PublishRunnerState $Token)
}

function Ensure-PublishRunner([string]$Token, [int]$TimeoutSeconds = 45) {
    Start-LocalSupervisor 'runner'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $state = Get-PublishRunnerState $Token
        if ($state.executor.ready -eq $true) { Write-Host '[ready] publish executor'; return }
        if (-not (Get-OwnedSupervisor 'runner')) { throw 'The publish supervisor stopped. See .local-start/runner-*.err.log.' }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The publish executor has not sent a heartbeat. See its state in the console and .local-start/runner-*.out.log.'
}

function Invoke-PublishRunner {
    $secretPath = Join-Path $LocalDir 'publish-runner-token.dpapi'
    $names = @('PUBLISH_RUNNER_TOKEN', 'PUBLISH_API_URL', 'PUBLISH_COOKIE', 'COOKIE', 'ADMIN_PASSWORD', 'PUBLISH_PASSWORD', 'SETUP_TOKEN')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        $env:PUBLISH_RUNNER_TOKEN = Read-LocalPassword $secretPath
        $env:PUBLISH_API_URL = 'http://127.0.0.1:8787'
        # Only this dedicated secret enters the runner environment. No password or
        # administrator cookie is passed on the command line or via environment.
        Invoke-Npm (Join-Path $RepoRoot 'worker') @('run', 'publish:runner')
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
}

function Invoke-PublishSupervisor {
    $delay = 3
    while ($true) {
        $startedAt = [DateTime]::UtcNow
        try { Invoke-PublishRunner; Write-Host '[runner] Executor exited; restarting.' }
        catch { Write-Warning ('Publish executor exited: ' + $_.Exception.Message) }
        if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 60) { $delay = 3 }
        Write-Host "[runner] Restart in $delay seconds."
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min(30, $delay * 2)
    }
}
