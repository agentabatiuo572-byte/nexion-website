#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$NoPause,
    [switch]$HidePassword,
    [switch]$NonInteractive,
    [ValidateSet('site', 'api', 'admin', 'runner')][string]$Service
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = $PSScriptRoot
$LocalDir = Join-Path $RepoRoot '.local-start'
$LauncherPath = Join-Path $RepoRoot 'start-website.ps1'
$WindowsPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
. (Join-Path $RepoRoot 'scripts/launcher-publish.ps1')
. (Join-Path $RepoRoot 'scripts/launcher-ai.ps1')
# A .cmd launched from PowerShell 7 can inherit its incompatible Security module.
# Pin the built-in WinPS module before DPAPI commands are auto-loaded.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
}

function Initialize-PrivateDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { [void][IO.Directory]::CreateDirectory($Path) }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The private directory must not be a link.' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    # WinPS 5.1 Set-Acl also attempts SACL changes and can require admin privileges.
    # The .NET setter applies only the modified owner/access sections.
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
    else { $item.SetAccessControl($acl) }
}

function New-LocalPassword {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Save-LocalPassword([string]$Path, [string]$Password) {
    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    try { $encrypted = ConvertFrom-SecureString $secure } finally { $secure.Dispose() }
    # CreateNew is intentional: never overwrite an existing recovery credential.
    $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes($encrypted)
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
}

function Read-LocalPassword([string]$Path) {
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The credential file must not be a link.' }
    try { $secure = ConvertTo-SecureString ([IO.File]::ReadAllText($Path)) } catch {
        throw 'Cannot decrypt the saved password. Use the original Windows account; the administrator has NOT been reset.'
    }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

function Invoke-LocalApi([string]$BaseUri, [string]$Path, [string]$Method = 'GET', $Body = $null, [string]$Cookie = '', [string]$BearerToken = '', [ValidateRange(1, 30)][int]$TimeoutSeconds = 15) {
    $uri = [Uri]($BaseUri.TrimEnd('/') + $Path)
    if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1', 'localhost', '[::1]')) { throw 'Only loopback HTTP is allowed.' }
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $request = New-Object Net.Http.HttpRequestMessage((New-Object Net.Http.HttpMethod($Method)), $uri)
    if ($null -ne $Body) { $request.Content = New-Object Net.Http.StringContent(($Body | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json') }
    if ($Cookie) { [void]$request.Headers.TryAddWithoutValidation('Cookie', $Cookie) }
    if ($BearerToken) { [void]$request.Headers.TryAddWithoutValidation('Authorization', ('Bearer ' + $BearerToken)) }
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            try { $json = $content | ConvertFrom-Json } catch { throw "Non-JSON response from $Path (HTTP $([int]$response.StatusCode))." }
            $session = ''
            if ($response.Headers.Contains('Set-Cookie')) {
                foreach ($value in $response.Headers.GetValues('Set-Cookie')) {
                    if ($value -match '^(nx_sid=[^;]+)') { $session = $Matches[1] }
                }
            }
            return [pscustomobject]@{ Status = [int]$response.StatusCode; Json = $json; Cookie = $session }
        } finally { $response.Dispose() }
    } finally { $request.Dispose(); $client.Dispose(); $handler.Dispose() }
}

function Get-InitializationState([string]$BaseUri) {
    $reply = Invoke-LocalApi $BaseUri '/api/auth/state'
    if ($reply.Status -ne 200 -or $reply.Json.initialized -isnot [bool]) { throw 'The initialization state could not be verified.' }
    return $reply.Json.initialized
}

function Confirm-AdminPassword([string]$BaseUri, [string]$Password) {
    $reply = Invoke-LocalApi $BaseUri '/api/auth/login' 'POST' @{ password = $Password }
    if ($reply.Status -ne 200 -or $reply.Json.ok -ne $true -or -not $reply.Cookie) {
        throw "Saved password did not authenticate (HTTP $($reply.Status)). Account and file were preserved. If the account password differs, move admin-password.dpapi aside, rerun interactively and enter the current password."
    }
    try {
        $me = Invoke-LocalApi $BaseUri '/api/me' 'GET' $null $reply.Cookie
        if ($me.Status -ne 200 -or $me.Json.actor -ne 'admin') { throw 'Administrator session verification failed.' }
    } finally {
        $logout = Invoke-LocalApi $BaseUri '/api/auth/logout' 'POST' $null $reply.Cookie
        if ($logout.Status -ne 200) { Write-Warning 'The temporary verification session could not be closed.' }
    }
}

function Get-LocalSetupToken([string]$Root) {
    # The launcher's .dev.vars is expected. Honor an explicit setup token in it;
    # reject other environment layers whose precedence is not established here.
    $worker = Join-Path $Root 'worker'
    $devVars = Join-Path $worker '.dev.vars'
    $overrides = @(Get-ChildItem -LiteralPath $worker -Force -File | Where-Object { ($_.Name -like '.dev.vars*' -and $_.Name -notin @('.dev.vars', '.dev.vars.example')) -or $_.Name -like '.env*' })
    if ($overrides.Count -gt 0 -or $env:SETUP_TOKEN) { throw 'Custom worker environment detected. Complete /admin/setup with its configured token first; no existing account was changed.' }
    if (Test-Path -LiteralPath $devVars) {
        $token = Get-DevVariable ([IO.File]::ReadAllText($devVars)) 'SETUP_TOKEN'
        if ($null -ne $token) { return $token }
    }
    $config = [IO.File]::ReadAllText((Join-Path $Root 'worker/wrangler.jsonc'))
    $match = [regex]::Match($config, '"SETUP_TOKEN"\s*:\s*("(?:\\.|[^"\\])*")')
    if (-not $match.Success) { throw 'SETUP_TOKEN is missing from the local worker configuration.' }
    return ($match.Groups[1].Value | ConvertFrom-Json)
}

function Initialize-LocalAdmin([string]$BaseUri, [string]$CredentialPath, [string]$SetupToken = '', [switch]$NonInteractive) {
    $initialized = Get-InitializationState $BaseUri
    $created = -not $initialized
    $needsSave = $false
    if (-not $initialized -and -not $SetupToken) { $SetupToken = Get-LocalSetupToken $RepoRoot }
    if (Test-Path -LiteralPath $CredentialPath) { $password = Read-LocalPassword $CredentialPath }
    elseif ($initialized) {
        if ($NonInteractive) { throw 'Administrator already exists, but no local password is saved. Run interactively once and enter the existing password; no reset will be performed.' }
        $secure = Read-Host 'Existing administrator password (will be saved encrypted)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
        $needsSave = $true
    } else {
        $password = New-LocalPassword
        Save-LocalPassword $CredentialPath $password
    }
    if (-not $initialized) {
        try { $setup = Invoke-LocalApi $BaseUri '/api/auth/setup' 'POST' @{ token = $SetupToken; password = $password } }
        catch { $setup = $null }
        # A timeout/500 can happen AFTER the account was stored. Re-read, never reset.
        if (-not (Get-InitializationState $BaseUri)) {
            $status = if ($null -eq $setup) { 'network error' } else { "HTTP $($setup.Status)" }
            throw "Initialization did not complete ($status). The encrypted candidate password was kept for retry."
        }
    }
    Confirm-AdminPassword $BaseUri $password
    if ($needsSave) { Save-LocalPassword $CredentialPath $password }
    return [pscustomobject]@{ Password = $password; Created = $created; Verified = $true }
}

function Get-ServiceDefinition([string]$Name) {
    switch ($Name) {
        'site' { return @{ Name = 'site'; Port = 4321; Dir = $RepoRoot; Marker = (Join-Path $RepoRoot 'node_modules/astro/'); Url = 'http://127.0.0.1:4321/'; Arguments = @('run', 'dev', '--', '--host', '127.0.0.1') } }
        'api' { return @{ Name = 'api'; Port = 8787; Dir = (Join-Path $RepoRoot 'worker'); Marker = (Join-Path $RepoRoot 'worker/node_modules/'); Url = 'http://127.0.0.1:8787/api/health' } }
        'admin' { return @{ Name = 'admin'; Port = 5175; Dir = (Join-Path $RepoRoot 'admin'); Marker = (Join-Path $RepoRoot 'admin/node_modules/'); Url = 'http://127.0.0.1:5175/admin/'; Arguments = @('run', 'dev', '--', '--host', '127.0.0.1', '--strictPort', '--base', '/') } }
    }
}

function Test-ServiceCommandPath([string]$CommandLine, [string]$Marker) {
    # npm shims use node_modules\.bin\\..\package; compare resolved path syntax,
    # not raw command-line substrings. A later data/config argument is NOT ownership.
    $arguments = @([regex]::Matches($CommandLine, '(?:[^\s"]+|"[^"]*")+') | ForEach-Object {
        $token = $_.Value
        if ($token.StartsWith('"') -and $token.EndsWith('"')) { $token.Substring(1, $token.Length - 2) }
        else { $token }
    })
    if ($arguments.Count -eq 0) { return $false }
    $entry = $arguments[0]
    try { $executable = [IO.Path]::GetFileName($entry.Replace('/', '\')) }
    catch { return $false }
    if ($executable -in @('node', 'node.exe')) {
        $index = 1
        while ($index -lt $arguments.Count) {
            $option = $arguments[$index]
            if ($option -eq '--') { $index++; break }
            if ($option -in @('-r', '--require', '--import', '--loader', '--experimental-loader')) { $index += 2; continue }
            if ($option -match '^--(?:require|import|loader|experimental-loader|max-old-space-size|max-semi-space-size)=.+$' -or
                $option -match '^--(?:no-warnings|no-deprecation|trace-warnings|trace-deprecation|enable-source-maps|experimental-strip-types)$' -or
                $option -match '^--inspect(?:-brk|-wait)?(?:=.+)?$') { $index++; continue }
            # Eval/print and unknown option arities cannot establish a script path.
            if ($option.StartsWith('-')) { return $false }
            break
        }
        if ($index -ge $arguments.Count) { return $false }
        $entry = $arguments[$index]
    }
    if ($entry.Contains('"') -or $entry -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\)') { return $false }
    $directory = [IO.Path]::GetFullPath($Marker.Replace('/', '\')).TrimEnd('\') + '\'
    try { $path = [IO.Path]::GetFullPath($entry.Replace('/', '\')) }
    catch { return $false }
    return $path.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase)
}

function Get-OwnedListener($Definition) {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Definition.Port })
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
        $command = [string]$process.CommandLine
        if ($listener.LocalAddress -notin @('127.0.0.1', '::1') -or -not (Test-ServiceCommandPath $command $Definition.Marker)) {
            throw "Port $($Definition.Port) is occupied by another or non-loopback service (PID $($listener.OwningProcess)). It was NOT stopped."
        }
    }
    return $listeners
}

function Wait-LocalService($Definition, [int]$TimeoutSeconds = 120) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $listeners = @(Get-OwnedListener $Definition)
        if ($listeners.Count -gt 0) {
            try {
                if ($Definition.Name -eq 'api') {
                    $reply = Invoke-LocalApi 'http://127.0.0.1:8787' '/api/health'
                    if ($reply.Status -eq 200 -and $reply.Json.service -eq 'nexgrid-site-worker' -and $reply.Json.environment -eq 'dev') { return }
                } else {
                    $response = Invoke-WebRequest -Uri $Definition.Url -UseBasicParsing -TimeoutSec 8 -MaximumRedirection 0
                    if ($response.StatusCode -eq 200 -and $response.Content -match 'Uvel') { return }
                }
            } catch { }
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$($Definition.Name) did not become ready on port $($Definition.Port). See $LocalDir for logs."
}

function Ensure-LocalService([string]$Name) {
    $definition = Get-ServiceDefinition $Name
    if (@(Get-OwnedListener $definition).Count -gt 0) {
        Write-Host "[reuse] $Name :$($definition.Port)"
    } else {
        Start-LocalSupervisor $Name
    }
    Wait-LocalService $definition
    Write-Host "[ready] $Name"
}

function Invoke-Npm([string]$Directory, [string[]]$Arguments) {
    Push-Location -LiteralPath $Directory
    $aiEnvironment = Remove-AiProcessEnvironment
    try {
        & (Get-Command npm.cmd -ErrorAction Stop).Source @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm failed in $Directory (exit $LASTEXITCODE)." }
    } finally { Restore-AiProcessEnvironment $aiEnvironment; Pop-Location }
}

function Start-Website {
    $node = Get-Command node.exe -ErrorAction Stop
    $versionText = & $node.Source --version
    if ([version]$versionText.TrimStart('v') -lt [version]'24.0.0') { throw 'Node.js 24 or newer is required for the managed publisher.' }
    [void](Get-Command npm.cmd -ErrorAction Stop)
    Initialize-PrivateDirectory $LocalDir
    # Validate all fixed ports before installing, building, or sending credentials.
    foreach ($name in @('api', 'site', 'admin')) { [void](Get-OwnedListener (Get-ServiceDefinition $name)) }
    $publish = Initialize-PublishConfiguration $RepoRoot $LocalDir
    foreach ($entry in @(@('', 'node_modules/astro/bin/astro.mjs'), @('admin', 'node_modules/vite/bin/vite.js'), @('worker', 'node_modules/wrangler/bin/wrangler.js'), @('schema', 'node_modules/zod/package.json'))) {
        $directory = if ($entry[0]) { Join-Path $RepoRoot $entry[0] } else { $RepoRoot }
        if (-not (Test-Path -LiteralPath (Join-Path $directory $entry[1]))) {
            Write-Host "[install] Dependencies in $directory"
            Invoke-Npm $directory @('ci', '--no-audit', '--no-fund')
        }
    }
    $live = Join-Path $RepoRoot 'dist-live'
    if (-not (Test-Path -LiteralPath $live)) {
        Write-Host '[build] Preparing the first local website snapshot'
        Invoke-Npm $RepoRoot @('run', 'build')
        Invoke-Npm $RepoRoot @('run', 'build:console')
        Push-Location -LiteralPath (Join-Path $RepoRoot 'worker')
        try { & $node.Source 'promote.mjs'; if ($LASTEXITCODE -ne 0) { throw 'Initial local snapshot assembly failed.' } }
        finally { Pop-Location }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $live 'index.html')) -or -not (Test-Path -LiteralPath (Join-Path $live 'admin/index.html'))) {
        throw 'Existing dist-live is incomplete. It was preserved; restore its website and admin files before retrying.'
    }
    Ensure-LocalService 'api'
    Ensure-PublishApi $publish.Token
    # A dev server can keep its pre-update module graph across a Git fast-forward.
    # Refresh only the stateless code surfaces; API/runner retain their job-safe reload protocols.
    Restart-OwnedFrontendService 'site'
    Ensure-LocalService 'site'
    Restart-OwnedFrontendService 'admin'
    Ensure-LocalService 'admin'
    # Recheck ownership immediately before sending credentials to the local API.
    if (@(Get-OwnedListener (Get-ServiceDefinition 'api')).Count -eq 0) { throw 'The local API stopped before initialization.' }
    $account = Initialize-LocalAdmin 'http://127.0.0.1:8787' (Join-Path $LocalDir 'admin-password.dpapi') -NonInteractive:$NonInteractive
    Ensure-PublishRunner $publish.Token
    $publishedUrl = 'http://127.0.0.1:8787/'
    Write-Host ''
    Write-Host ('Published website: ' + $publishedUrl)
    Write-Host ('Console: ' + (Get-ServiceDefinition 'admin').Url)
    Write-Host ('Development preview: ' + (Get-ServiceDefinition 'site').Url)
    if ($account.Created) { Write-Host 'Administrator initialized and login verified.' }
    else { Write-Host 'Existing administrator preserved; login verified.' }
    if (-not $HidePassword) { Write-Host "Password: $($account.Password)" -ForegroundColor Yellow }
    Write-Host 'Password is encrypted for this Windows account in .local-start/admin-password.dpapi.'
    Write-Host 'Services stay running after this launcher window closes.'
    Write-Host 'Publish executor is ready. Click Publish in the console to build, verify and update the local snapshot.'
    if (-not $NoBrowser) {
        Start-Process $publishedUrl
        Start-Process (Get-ServiceDefinition 'admin').Url
    }
}

# Dot-sourcing exposes helpers to regression tests without starting services.
if ($MyInvocation.InvocationName -ne '.') {
    $exitCode = 0
    $mutex = $null
    $locked = $false
    try {
        if ($Service) {
            $mutex = New-Object Threading.Mutex($false, (Get-LauncherMutexName $Service))
            try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
            if (-not $locked) { throw "The $Service supervisor is already running." }
            if ($Service -eq 'runner') {
                Invoke-PublishSupervisor
            } else {
                $definition = Get-ServiceDefinition $Service
                $env:ASTRO_TELEMETRY_DISABLED = '1'
                $env:WRANGLER_SEND_METRICS = 'false'
                # Root dev asset base also serves /admin without a trailing slash after login.
                # Production builds retain the configured /admin/ asset base.
                if ($Service -eq 'api') { Invoke-ApiSupervisor }
                # localhost can resolve to an IPv6 loopback that Windows blocks.
                else { Invoke-Npm $definition.Dir $definition.Arguments }
            }
        } else {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($RepoRoot.ToLowerInvariant()))).Replace('-', '') }
            finally { $sha.Dispose() }
            $mutex = New-Object Threading.Mutex($false, "Local\NexGridLauncher-$key")
            try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
            if (-not $locked) { throw 'Another launcher is still working. Wait for its result.' }
            Start-Website
        }
    } catch {
        $exitCode = 1
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
        if (-not $Service -and -not $NoPause -and -not $NonInteractive) { [void](Read-Host 'Press Enter to close this window') }
    }
    exit $exitCode
}
