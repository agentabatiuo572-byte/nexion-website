#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:Passed = 0
$script:Failures = New-Object 'Collections.Generic.List[string]'
$script:SavedFunctions = @{}
$script:TemporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('nexgrid-launcher-regression-' + [Guid]::NewGuid().ToString('N'))))
$script:LauncherUnderTest = Join-Path (Split-Path -Parent $PSScriptRoot) 'start-website.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Throws([scriptblock]$Action, [string]$ExpectedMessage) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    if ($null -eq $caught) { throw 'Expected rejection, but the operation succeeded.' }
    if ($ExpectedMessage -and $caught.Exception.Message -notlike ('*' + $ExpectedMessage + '*')) {
        throw ('Unexpected rejection: ' + $caught.Exception.Message)
    }
}

function Invoke-Test([string]$CaseName, [scriptblock]$Action) {
    try {
        & $Action | Out-Null
        $script:Passed++
        Write-Host ('[PASS] ' + $CaseName)
    } catch {
        $message = $CaseName + ': ' + $_.Exception.Message
        $script:Failures.Add($message)
        Write-Host ('[FAIL] ' + $message)
    }
}

function Set-TestFunction([string]$Name, [scriptblock]$Body) {
    if (-not $script:SavedFunctions.ContainsKey($Name)) {
        $existing = Get-Item -LiteralPath ('Function:' + $Name) -ErrorAction SilentlyContinue
        $script:SavedFunctions[$Name] = if ($existing) { $existing.ScriptBlock } else { $null }
    }
    Set-Item -LiteralPath ('Function:script:' + $Name) -Value $Body
}

function Restore-TestFunctions {
    foreach ($name in $script:SavedFunctions.Keys) {
        $original = $script:SavedFunctions[$name]
        if ($null -eq $original) { Remove-Item -LiteralPath ('Function:script:' + $name) -ErrorAction SilentlyContinue }
        else { Set-Item -LiteralPath ('Function:script:' + $name) -Value $original }
    }
}

function New-TestCredentialPath([string]$Name) {
    return Join-Path $script:TemporaryRoot ($Name + '.dpapi')
}

function Reset-FakeApi([bool]$Initialized, [string]$Password, [string]$CredentialPath) {
    $script:FakeApi = @{
        Initialized = $Initialized
        Password = $Password
        CredentialPath = $CredentialPath
        SetupMode = 'Success'
        MalformedState = $false
        Actor = 'admin'
        SetupCalls = 0
        LogoutCalls = 0
        Paths = New-Object 'Collections.Generic.List[string]'
    }
}

function Assert-NoReset([string]$ExpectedPassword, [string]$ExpectedCiphertext, [string]$CredentialPath) {
    Assert-True ($script:FakeApi.SetupCalls -eq 0) 'Existing administrator received a setup request.'
    Assert-True ($script:FakeApi.Password -ceq $ExpectedPassword) 'Existing administrator password changed.'
    Assert-True ([IO.File]::ReadAllText($CredentialPath) -ceq $ExpectedCiphertext) 'Saved credential changed.'
}

function New-PublishFixture([string]$Name) {
    $root = Join-Path $script:TemporaryRoot $Name
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'worker'))
    [IO.File]::WriteAllText((Join-Path $root 'worker/wrangler.jsonc'), '{"vars":{"SETUP_TOKEN":"fixture-setup-token"}}')
    return @{ Root = $root; Private = (Join-Path $root '.local-start'); Vars = (Join-Path $root 'worker/.dev.vars') }
}

function New-FakeProcess([int]$Number, [int]$Parent, [string]$Command, [DateTime]$Created) {
    return [pscustomobject]@{ ProcessId = $Number; ParentProcessId = $Parent; CommandLine = $Command; CreationDate = $Created }
}

try {
    # Dot-source only. The service-starting entry point must never run here.
    . $script:LauncherUnderTest
    Initialize-PrivateDirectory $script:TemporaryRoot

    foreach ($name in @('site', 'admin')) {
        Invoke-Test ($name + ': launch and readiness use the same explicit IPv4 loopback') {
            $definition = Get-ServiceDefinition $name
            $uri = [Uri]$definition.Url
            $arguments = @($definition.Arguments)
            $hostIndex = [Array]::IndexOf($arguments, '--host')
            Assert-True ($uri.Host -ceq '127.0.0.1' -and $uri.Port -eq $definition.Port) 'Readiness URL depends on localhost resolution.'
            Assert-True ($hostIndex -ge 0 -and $arguments[$hostIndex + 1] -ceq $uri.Host) 'Server binding differs from its readiness URL.'
            if ($name -eq 'admin') {
                Assert-True ($arguments -contains '--strictPort' -and ($arguments -join ' ').EndsWith('--base /')) 'Admin lost fixed-port or post-login asset routing.'
            }
        }
    }

    Set-TestFunction 'Invoke-LocalApi' {
        param([string]$BaseUri, [string]$Path, [string]$Method = 'GET', $Body = $null, [string]$Cookie = '')
        Assert-True ($BaseUri -eq 'http://127.0.0.1:18787') 'Unexpected API destination.'
        $script:FakeApi.Paths.Add($Path)
        switch ($Path) {
            '/api/auth/state' {
                Assert-True ($Method -eq 'GET') 'State request must use GET.'
                $value = if ($script:FakeApi.MalformedState) { 'true' } else { $script:FakeApi.Initialized }
                return [pscustomobject]@{ Status = 200; Json = @{ initialized = $value }; Cookie = '' }
            }
            '/api/auth/setup' {
                Assert-True ($Method -eq 'POST') 'Setup request must use POST.'
                $script:FakeApi.SetupCalls++
                Assert-True (-not $script:FakeApi.Initialized) 'Setup was attempted for an initialized administrator.'
                Assert-True ($Body.token -ceq 'isolated-test-token') 'Unexpected setup token.'
                Assert-True (Test-Path -LiteralPath $script:FakeApi.CredentialPath) 'Credential was not saved before setup.'
                $saved = Read-LocalPassword $script:FakeApi.CredentialPath
                Assert-True ($saved -ceq $Body.password) 'Persisted candidate differs from setup password.'
                if ($script:FakeApi.SetupMode -eq 'LostBeforeCommit') { throw 'Simulated connection loss before commit.' }
                $script:FakeApi.Initialized = $true
                if ($script:FakeApi.SetupMode -eq 'ConcurrentAdministrator') {
                    $script:FakeApi.Password = 'isolated-other-administrator-password'
                    return [pscustomobject]@{ Status = 409; Json = @{ ok = $false }; Cookie = '' }
                }
                $script:FakeApi.Password = $Body.password
                if ($script:FakeApi.SetupMode -eq 'LostAfterCommit') { throw 'Simulated response loss after commit.' }
                return [pscustomobject]@{ Status = 200; Json = @{ ok = $true }; Cookie = '' }
            }
            '/api/auth/login' {
                Assert-True ($Method -eq 'POST') 'Login request must use POST.'
                if (-not $script:FakeApi.Initialized -or $Body.password -cne $script:FakeApi.Password) {
                    return [pscustomobject]@{ Status = 401; Json = @{ ok = $false }; Cookie = '' }
                }
                return [pscustomobject]@{ Status = 200; Json = @{ ok = $true }; Cookie = 'nx_sid=isolated-session' }
            }
            '/api/me' {
                Assert-True ($Method -eq 'GET' -and $Cookie -ceq 'nx_sid=isolated-session') 'Administrator verification lost its session.'
                return [pscustomobject]@{ Status = 200; Json = @{ actor = $script:FakeApi.Actor }; Cookie = '' }
            }
            '/api/auth/logout' {
                Assert-True ($Method -eq 'POST' -and $Cookie -ceq 'nx_sid=isolated-session') 'Logout lost its session.'
                $script:FakeApi.LogoutCalls++
                return [pscustomobject]@{ Status = 200; Json = @{ ok = $true }; Cookie = '' }
            }
            default { throw ('Unexpected API route: ' + $Path) }
        }
    }
    Set-TestFunction 'Read-Host' { throw 'Regression tests must never prompt for an existing password.' }
    Set-TestFunction 'Start-Process' { throw 'Regression tests must never start a process.' }
    Set-TestFunction 'Stop-Process' { throw 'Regression tests must never stop a process.' }

    $script:RoundTripPath = New-TestCredentialPath 'round-trip'
    $script:RoundTripPassword = New-LocalPassword
    Invoke-Test 'DPAPI persists and decrypts the exact synthetic password' {
        Save-LocalPassword $script:RoundTripPath $script:RoundTripPassword
        Assert-True ((Read-LocalPassword $script:RoundTripPath) -ceq $script:RoundTripPassword) 'DPAPI round trip changed the password.'
    }
    Invoke-Test 'DPAPI file contains encrypted data instead of plaintext' {
        $ciphertext = [IO.File]::ReadAllText($script:RoundTripPath)
        Assert-True ($ciphertext.Length -gt 0 -and $ciphertext -cmatch '^[0-9a-fA-F]+$') 'DPAPI output is not an encoded encrypted payload.'
        Assert-True ($ciphertext.IndexOf($script:RoundTripPassword, [StringComparison]::Ordinal) -lt 0) 'Plaintext password was written to disk.'
    }
    Invoke-Test 'DPAPI duplicate write rejects and preserves the original file' {
        $before = [IO.File]::ReadAllText($script:RoundTripPath)
        Assert-Throws { Save-LocalPassword $script:RoundTripPath (New-LocalPassword) } ''
        Assert-True ([IO.File]::ReadAllText($script:RoundTripPath) -ceq $before) 'Duplicate write changed the encrypted file.'
        Assert-True ((Read-LocalPassword $script:RoundTripPath) -ceq $script:RoundTripPassword) 'Duplicate write changed the password.'
    }
    Invoke-Test 'DPAPI corrupted file rejects without replacement' {
        $path = New-TestCredentialPath 'corrupt'
        [IO.File]::WriteAllText($path, 'deliberately-invalid-dpapi', [Text.Encoding]::ASCII)
        Assert-Throws { Read-LocalPassword $path } 'Cannot decrypt the saved password'
        Assert-True ([IO.File]::ReadAllText($path) -ceq 'deliberately-invalid-dpapi') 'Corrupted credential was replaced.'
    }
    Invoke-Test 'WinPS DPAPI works when inherited module discovery excludes its Security module' {
        $moduleDirectory = Join-Path $script:TemporaryRoot 'empty-module-path'
        Initialize-PrivateDirectory $moduleDirectory
        $childPath = Join-Path $script:TemporaryRoot 'check-winps-dpapi.ps1'
        $childSource = @'
#Requires -Version 5.1
param([string]$Launcher, [string]$CredentialPath, [string]$ModuleDirectory)
$ErrorActionPreference = 'Stop'
try {
    # Load only filesystem commands, then disable the startup-added module paths.
    Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop
    $env:PSModulePath = $ModuleDirectory
    . $Launcher
    $password = New-LocalPassword
    Save-LocalPassword $CredentialPath $password
    if ((Read-LocalPassword $CredentialPath) -cne $password) { throw 'Child DPAPI round trip failed.' }
    Write-Output 'ISOLATED_DPAPI_OK'
    exit 0
} catch {
    Write-Output ('ISOLATED_DPAPI_FAILED: ' + $_.Exception.Message)
    exit 1
}
'@
        [IO.File]::WriteAllText($childPath, $childSource, [Text.Encoding]::ASCII)
        $previousModulePath = $env:PSModulePath
        try {
            $env:PSModulePath = $moduleDirectory
            $childOutput = @(& $WindowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $childPath -Launcher $script:LauncherUnderTest -CredentialPath (New-TestCredentialPath 'child-winps') -ModuleDirectory $moduleDirectory 2>&1)
            $childExit = $LASTEXITCODE
        } finally { $env:PSModulePath = $previousModulePath }
        Assert-True ($childExit -eq 0 -and $childOutput -contains 'ISOLATED_DPAPI_OK') ('WinPS failed with isolated module discovery: ' + ($childOutput -join ' '))
    }

    Invoke-Test 'Rejected custom setup environment creates no candidate password file' {
        $path = New-TestCredentialPath 'custom-environment'
        Reset-FakeApi $false '' $path
        $originalTokenFunction = (Get-Item -LiteralPath 'Function:Get-LocalSetupToken').ScriptBlock
        Set-TestFunction 'Get-LocalSetupToken' { throw 'Custom worker environment detected.' }
        try {
            Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path -NonInteractive } 'Custom worker environment detected'
            Assert-True (-not (Test-Path -LiteralPath $path)) 'Rejected setup configuration left a stale candidate password.'
            Assert-True ($script:FakeApi.SetupCalls -eq 0 -and -not $script:FakeApi.Initialized) 'Rejected setup configuration changed administrator state.'
        } finally { Set-Item -LiteralPath 'Function:script:Get-LocalSetupToken' -Value $originalTokenFunction }
    }
    Invoke-Test 'Fresh administrator saves before setup and verifies a real session flow' {
        $path = New-TestCredentialPath 'fresh'
        Reset-FakeApi $false '' $path
        $result = Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive
        Assert-True ($result.Created -and $result.Verified) 'Fresh initialization did not report verified creation.'
        Assert-True ((Read-LocalPassword $path) -ceq $script:FakeApi.Password -and $result.Password -ceq $script:FakeApi.Password) 'Fresh password was not persisted consistently.'
        Assert-True (($script:FakeApi.Paths -join ',') -ceq '/api/auth/state,/api/auth/setup,/api/auth/state,/api/auth/login,/api/me,/api/auth/logout') 'Fresh initialization did not complete the required request sequence.'
        Assert-True ($script:FakeApi.SetupCalls -eq 1 -and $script:FakeApi.LogoutCalls -eq 1) 'Fresh initialization repeated setup or leaked its verification session.'
    }
    Invoke-Test 'Repeat launch preserves the existing account and encrypted password' {
        $path = New-TestCredentialPath 'repeat'
        $password = New-LocalPassword
        Save-LocalPassword $path $password
        $before = [IO.File]::ReadAllText($path)
        Reset-FakeApi $true $password $path
        $result = Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive
        Assert-True (-not $result.Created -and $result.Verified -and $result.Password -ceq $password) 'Repeat launch did not reuse the existing password.'
        Assert-NoReset $password $before $path
        Assert-True ($script:FakeApi.LogoutCalls -eq 1) 'Repeat verification session was not closed.'
    }
    Invoke-Test 'Lost setup response after commit recovers and remains repeatable' {
        $path = New-TestCredentialPath 'lost-after-commit'
        Reset-FakeApi $false '' $path
        $script:FakeApi.SetupMode = 'LostAfterCommit'
        $first = Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive
        $before = [IO.File]::ReadAllText($path)
        $second = Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive
        Assert-True ($first.Verified -and $second.Verified -and -not $second.Created) 'Committed setup response loss did not recover.'
        Assert-True ($first.Password -ceq $second.Password -and $second.Password -ceq (Read-LocalPassword $path)) 'Recovery changed the candidate password.'
        Assert-True ($script:FakeApi.SetupCalls -eq 1 -and $script:FakeApi.LogoutCalls -eq 2) 'Recovery repeated setup or leaked a verification session.'
        Assert-True ([IO.File]::ReadAllText($path) -ceq $before) 'Repeated recovery rewrote the credential file.'
    }
    Invoke-Test 'Uncommitted setup failure keeps its candidate for the next attempt' {
        $path = New-TestCredentialPath 'lost-before-commit'
        Reset-FakeApi $false '' $path
        $script:FakeApi.SetupMode = 'LostBeforeCommit'
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'Initialization did not complete'
        $candidate = Read-LocalPassword $path
        $before = [IO.File]::ReadAllText($path)
        Assert-True (-not $script:FakeApi.Initialized -and $script:FakeApi.LogoutCalls -eq 0) 'Failed setup invented a verified account.'
        $script:FakeApi.SetupMode = 'Success'
        $result = Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive
        Assert-True ($result.Verified -and $result.Password -ceq $candidate -and $script:FakeApi.SetupCalls -eq 2) 'Retry did not reuse the durable candidate.'
        Assert-True ([IO.File]::ReadAllText($path) -ceq $before) 'Retry overwrote the durable candidate.'
    }
    Invoke-Test 'Wrong saved candidate rejects without resetting an existing administrator' {
        $path = New-TestCredentialPath 'wrong-candidate'
        Save-LocalPassword $path (New-LocalPassword)
        $before = [IO.File]::ReadAllText($path)
        $actual = New-LocalPassword
        Reset-FakeApi $true $actual $path
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'Saved password did not authenticate'
        Assert-NoReset $actual $before $path
        Assert-True ($script:FakeApi.LogoutCalls -eq 0) 'Rejected login was treated as a verified session.'
    }
    Invoke-Test 'Concurrent initialization mismatch preserves both account and candidate' {
        $path = New-TestCredentialPath 'concurrent-administrator'
        Save-LocalPassword $path (New-LocalPassword)
        $before = [IO.File]::ReadAllText($path)
        Reset-FakeApi $false '' $path
        $script:FakeApi.SetupMode = 'ConcurrentAdministrator'
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'Saved password did not authenticate'
        Assert-True ($script:FakeApi.SetupCalls -eq 1 -and $script:FakeApi.Password -ceq 'isolated-other-administrator-password') 'Concurrent administrator was overwritten.'
        Assert-True ([IO.File]::ReadAllText($path) -ceq $before) 'Concurrent mismatch overwrote the saved candidate.'
    }
    Invoke-Test 'Existing administrator without a saved file never resets or prompts in noninteractive mode' {
        $path = New-TestCredentialPath 'missing-existing'
        $actual = New-LocalPassword
        Reset-FakeApi $true $actual $path
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'Administrator already exists, but no local password is saved'
        Assert-True (-not (Test-Path -LiteralPath $path)) 'Missing existing credential was replaced with a generated password.'
        Assert-True ($script:FakeApi.Password -ceq $actual -and $script:FakeApi.SetupCalls -eq 0) 'Existing administrator was reset.'
        Assert-True (($script:FakeApi.Paths -join ',') -ceq '/api/auth/state') 'Missing existing credential continued into authentication.'
    }
    Invoke-Test 'Malformed initialization state fails closed before creating a password' {
        $path = New-TestCredentialPath 'malformed-state'
        Reset-FakeApi $false '' $path
        $script:FakeApi.MalformedState = $true
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'initialization state could not be verified'
        Assert-True (-not (Test-Path -LiteralPath $path) -and $script:FakeApi.SetupCalls -eq 0) 'Invalid initialization state caused a write.'
    }
    Invoke-Test 'Nonadministrator session rejects and closes its temporary session' {
        $path = New-TestCredentialPath 'wrong-actor'
        $password = New-LocalPassword
        Save-LocalPassword $path $password
        $before = [IO.File]::ReadAllText($path)
        Reset-FakeApi $true $password $path
        $script:FakeApi.Actor = 'viewer'
        Assert-Throws { Initialize-LocalAdmin 'http://127.0.0.1:18787' $path 'isolated-test-token' -NonInteractive } 'Administrator session verification failed'
        Assert-NoReset $password $before $path
        Assert-True ($script:FakeApi.LogoutCalls -eq 1) 'Rejected administrator verification leaked a session.'
    }

    Set-TestFunction 'Get-NetTCPConnection' {
        [CmdletBinding()]
        param([string]$State)
        Assert-True ($State -eq 'Listen') 'Listener check queried a non-listening TCP state.'
        return $script:FakeListeners
    }
    Set-TestFunction 'Get-CimInstance' {
        [CmdletBinding()]
        param([string]$ClassName, [string]$Filter)
        Assert-True ($ClassName -eq 'Win32_Process') 'Listener check queried an unexpected CIM class.'
        Assert-True ($Filter -match '^ProcessId=([0-9]+)$') 'Listener check did not restrict its process query.'
        $processNumber = [int]$Matches[1]
        $script:CimQueries++
        Assert-True ($script:FakeCommands.ContainsKey($processNumber)) 'Listener check queried an unexpected process.'
        return [pscustomobject]@{ CommandLine = $script:FakeCommands[$processNumber] }
    }

    foreach ($name in @('site', 'api', 'admin')) {
        $definition = Get-ServiceDefinition $name
        Invoke-Test ($name + ': no listener returns empty without inspecting another port') {
            $script:CimQueries = 0
            $script:FakeCommands = @{}
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port + 1; LocalAddress = '0.0.0.0'; OwningProcess = 60000 })
            Assert-True (@(Get-OwnedListener $definition).Count -eq 0) 'Unrelated port was counted as an owned listener.'
            Assert-True ($script:CimQueries -eq 0) 'Unrelated port caused a process inspection.'
        }
        Invoke-Test ($name + ': owned IPv4 and IPv6 loopback listeners are reusable') {
            $script:CimQueries = 0
            $script:FakeCommands = @{
                60001 = ('node.exe "' + $definition.Marker.ToUpperInvariant().Replace('\', '/') + 'test-service.js"')
                60002 = ('node.exe "' + $definition.Marker + 'test-service.js"')
            }
            $script:FakeListeners = @(
                [pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 },
                [pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '::1'; OwningProcess = 60002 }
            )
            Assert-True (@(Get-OwnedListener $definition).Count -eq 2 -and $script:CimQueries -eq 2) 'Owned loopback listeners were not recognized.'
        }
        Invoke-Test ($name + ': conflicting process rejects without stopping it') {
            $script:FakeCommands = @{ 60001 = 'node.exe C:\unrelated-project\server.js' }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': npm bin parent segments resolve to the owned service') {
            $entry = switch ($definition.Name) {
                'site' { Join-Path $definition.Dir 'node_modules\.bin\\..\astro\bin\astro.mjs' }
                'api' { Join-Path $definition.Dir 'node_modules\.bin\\..\wrangler\bin\wrangler.js' }
                'admin' { Join-Path $definition.Dir 'node_modules\.bin\\..\vite\bin\vite.js' }
            }
            $script:FakeCommands = @{ 60001 = ('"node" "' + $entry + '" dev') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-True (@(Get-OwnedListener $definition).Count -eq 1) 'Equivalent npm entry path was not recognized.'
        }
        Invoke-Test ($name + ': dot segments mixed separators and case resolve to the owned service') {
            $entryLeaf = switch ($definition.Name) {
                'site' { 'astro/./bin/temporary/../astro.mjs' }
                'api' { 'wrangler/./bin/temporary/../wrangler.js' }
                'admin' { 'vite/./bin/temporary/../vite.js' }
            }
            $entry = $definition.Dir.ToUpperInvariant() + '/./node_modules\.bin/../' + $entryLeaf
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $entry + '" dev') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '::1'; OwningProcess = 60001 })
            Assert-True (@(Get-OwnedListener $definition).Count -eq 1) 'Normalized owned service path was not recognized.'
        }
        Invoke-Test ($name + ': marker followed by parent segments escaping the repository rejects') {
            $entry = $definition.Marker + '..\..\..\..\unrelated-project\server.js'
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $entry + '"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': adjacent directory with the same name prefix rejects') {
            $entry = $definition.Marker.TrimEnd('\', '/') + '-unrelated\server.js'
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $entry + '"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': quoted absolute service path accepts spaces in its directories') {
            $spaceDefinition = $definition.Clone()
            $spaceDefinition.Dir = Join-Path $script:TemporaryRoot 'repository with spaces'
            $spaceDefinition.Marker = Join-Path $spaceDefinition.Dir ('node_modules/package for ' + $definition.Name + '/')
            $entry = $spaceDefinition.Marker + 'bin/service entry.js'
            $script:FakeCommands = @{ 60001 = ('"C:\Program Files\nodejs\node.exe" "' + $entry + '" dev') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $spaceDefinition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-True (@(Get-OwnedListener $spaceDefinition).Count -eq 1) 'Quoted absolute service path with spaces was not recognized.'
        }
        Invoke-Test ($name + ': relative service path cannot establish repository ownership') {
            $relativeEntry = switch ($definition.Name) {
                'site' { '.\node_modules\astro\bin\astro.mjs' }
                'api' { '.\node_modules\wrangler\bin\wrangler.js' }
                'admin' { '.\node_modules\vite\bin\vite.js' }
            }
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $relativeEntry + '" dev') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': unrelated executable cannot claim ownership through a label argument') {
            $script:FakeCommands = @{ 60001 = ('"C:\unrelated-project\foreign.exe" --label="' + $definition.Marker + 'package.json"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': unrelated node script cannot claim ownership through a trailing argument') {
            $script:FakeCommands = @{ 60001 = ('node.exe C:\unrelated-project\server.js "' + $definition.Marker + 'package.json"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': known node option before the owned entry script accepts') {
            $script:FakeCommands = @{ 60001 = ('node.exe --no-warnings "' + $definition.Marker + 'test-service.js"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-True (@(Get-OwnedListener $definition).Count -eq 1) 'Known node option hid its owned entry script.'
        }
        Invoke-Test ($name + ': node eval mode cannot claim ownership through a trailing script path') {
            $script:FakeCommands = @{ 60001 = ('node.exe -e "void 0" "' + $definition.Marker + 'test-service.js"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': unknown node option fails closed before interpreting a script path') {
            $script:FakeCommands = @{ 60001 = ('node.exe --unknown-launcher-test-option "' + $definition.Marker + 'test-service.js"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': drive-relative path cannot establish repository ownership') {
            $entry = $definition.Marker.Replace('/', '\') + 'test-service.js'
            $entry = $entry.Substring(0, 2) + $entry.Substring(3)
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $entry + '"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': root-relative path cannot establish repository ownership') {
            $entry = ($definition.Marker.Replace('/', '\') + 'test-service.js').Substring(2)
            $script:FakeCommands = @{ 60001 = ('node.exe "' + $entry + '"') }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        Invoke-Test ($name + ': missing process command line rejects ownership') {
            $script:FakeCommands = @{ 60001 = $null }
            $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 })
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
        foreach ($address in @('0.0.0.0', '::', '192.0.2.10')) {
            Invoke-Test ($name + ': nonloopback address ' + $address + ' rejects even with an owned command') {
                $script:FakeCommands = @{ 60001 = ('node.exe "' + $definition.Marker + 'test-service.js"') }
                $script:FakeListeners = @([pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = $address; OwningProcess = 60001 })
                Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
            }
        }
        Invoke-Test ($name + ': mixed owned and conflicting listeners rejects the whole port') {
            $script:FakeCommands = @{
                60001 = ('node.exe "' + $definition.Marker + 'test-service.js"')
                60002 = 'node.exe C:\unrelated-project\server.js'
            }
            $script:FakeListeners = @(
                [pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '127.0.0.1'; OwningProcess = 60001 },
                [pscustomobject]@{ LocalPort = $definition.Port; LocalAddress = '::1'; OwningProcess = 60002 }
            )
            Assert-Throws { Get-OwnedListener $definition } 'occupied by another or non-loopback service'
        }
    }

    # These cases use a real isolated Git repository, private ACLs and DPAPI files;
    # process controls remain fake so the current website/API can never be stopped.
    & (Get-Command git.exe).Source init --quiet $script:TemporaryRoot
    Assert-True ($LASTEXITCODE -eq 0) 'Could not initialize the isolated credential fixture.'
    [IO.File]::WriteAllText((Join-Path $script:TemporaryRoot '.gitignore'), ".local-start/`n**/worker/.dev.vars`n")
    Invoke-Test 'Publish secret is random, durable, encrypted and private on disk' {
        $script:PublishFixture = New-PublishFixture 'publish-fresh'
        $first = Initialize-PublishConfiguration $script:PublishFixture.Root $script:PublishFixture.Private
        Assert-True ($first.Changed -and $first.Token.Length -ge 32) 'Fresh publish secret was not created.'
        $secret = Join-Path $script:PublishFixture.Private 'publish-runner-token.dpapi'
        $before = [IO.File]::ReadAllText($secret)
        $varsBefore = [IO.File]::ReadAllText($script:PublishFixture.Vars)
        $second = Initialize-PublishConfiguration $script:PublishFixture.Root $script:PublishFixture.Private
        Assert-True (-not $second.Changed -and $first.Token -ceq $second.Token) 'Repeat launch rotated the publish secret.'
        Assert-True ([IO.File]::ReadAllText($secret) -ceq $before -and [IO.File]::ReadAllText($script:PublishFixture.Vars) -ceq $varsBefore) 'Repeat launch rewrote stable secret files.'
        Assert-True ((Read-LocalPassword $secret) -ceq $first.Token -and $before.IndexOf($first.Token, [StringComparison]::Ordinal) -lt 0) 'Publish recovery secret was not encrypted correctly.'
        $acl = Get-Acl -LiteralPath $script:PublishFixture.Vars
        Assert-True $acl.AreAccessRulesProtected 'Plaintext worker binding retained inherited ACLs.'
        $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            Assert-True ($rule.IdentityReference.Value -in $allowed -and -not $rule.IsInherited) 'Plaintext worker binding grants unrelated accounts access.'
        }
    }
    Invoke-Test 'Existing custom setup and other dev vars survive publish configuration' {
        $fixture = New-PublishFixture 'publish-custom'
        $token = New-LocalPassword
        $prefix = "# Keep this comment`nSETUP_TOKEN='custom-fixture-setup-token' # Preserve inline comment`nCUSTOM_SETTING=keep-me`nPUBLISH_RUNNER_TOKEN=$token`n"
        [IO.File]::WriteAllText($fixture.Vars, $prefix)
        $first = Initialize-PublishConfiguration $fixture.Root $fixture.Private
        Assert-True ($first.Token -ceq $token) 'Existing dedicated secret was rotated.'
        Assert-True ([IO.File]::ReadAllText($fixture.Vars).StartsWith($prefix, [StringComparison]::Ordinal)) 'Existing custom configuration was changed.'
        $previousSetup = $env:SETUP_TOKEN
        try {
            $env:SETUP_TOKEN = $null
            Assert-True ((Get-LocalSetupToken $fixture.Root) -ceq 'custom-fixture-setup-token') 'Explicit custom setup token was not honored.'
            Assert-True ((Get-LocalSetupToken $script:PublishFixture.Root) -ceq 'fixture-setup-token') 'Launcher-owned dev vars incorrectly blocked default setup.'
        } finally { $env:SETUP_TOKEN = $previousSetup }
    }
    Invoke-Test 'A custom DPAPI token survives dotenv restoration and repeat launch' {
        $fixture = New-PublishFixture 'publish-special-token'
        $token = "dedicated-token-with-'quote-and-\backslash-1234567890"
        Initialize-PrivateDirectory $fixture.Private
        Save-LocalPassword (Join-Path $fixture.Private 'publish-runner-token.dpapi') $token
        [void](Initialize-PublishConfiguration $fixture.Root $fixture.Private)
        Assert-True ((Get-DevVariable ([IO.File]::ReadAllText($fixture.Vars)) 'PUBLISH_RUNNER_TOKEN') -ceq $token) 'Dotenv serialization changed a custom token.'
        Assert-True ((Initialize-PublishConfiguration $fixture.Root $fixture.Private).Token -ceq $token) 'Second launch did not recover the custom token.'
    }
    Invoke-Test 'Quoted tokens ending in a backslash round-trip without changing bytes' {
        $token = "long-publisher-token-'with-trailing-backslash-123456\"
        $serialized = ConvertTo-DotEnvValue $token
        Assert-True ((Get-DevVariable ('VALUE=' + $serialized) 'VALUE') -ceq $token) 'Trailing backslash broke dotenv recovery.'
    }
    Invoke-Test 'A publish secret path not ignored by Git rejects before a plaintext write' {
        $fixture = New-PublishFixture 'publish-not-ignored'
        [IO.File]::WriteAllText((Join-Path $fixture.Root '.gitignore'), "!worker/.dev.vars`n")
        Assert-Throws { Initialize-PublishConfiguration $fixture.Root $fixture.Private } 'not ignored by Git'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Vars) -and -not (Test-Path -LiteralPath $fixture.Private)) 'Rejected Git protection still wrote a secret.'
    }
    Invoke-Test 'Dev-variable parsing preserves quoted hash content and ignores real comments' {
        Assert-True ((Get-DevVariable 'SETUP_TOKEN="contains#hash" # comment' 'SETUP_TOKEN') -ceq 'contains#hash') 'Quoted hash content was treated as a comment.'
        Assert-True ((Get-DevVariable 'SETUP_TOKEN=plain#comment' 'SETUP_TOKEN') -ceq 'plain') 'Bare comment parsing differs from dotenv.'
        Assert-Throws { Get-DevVariable 'SETUP_TOKEN="unterminated' 'SETUP_TOKEN' } 'Unsupported quoted'
    }
    Invoke-Test 'A tracked secret path rejects even when ignore patterns match' {
        $fixture = New-PublishFixture 'publish-tracked'
        [IO.File]::WriteAllText($fixture.Vars, 'CUSTOM_SETTING=synthetic-no-secret')
        & (Get-Command git.exe).Source -C $script:TemporaryRoot add --force -- $fixture.Vars
        Assert-True ($LASTEXITCODE -eq 0) 'Could not stage the synthetic tracked-file fixture.'
        Assert-Throws { Initialize-PublishConfiguration $fixture.Root $fixture.Private } 'not ignored by Git'
        Assert-True ([IO.File]::ReadAllText($fixture.Vars) -ceq 'CUSTOM_SETTING=synthetic-no-secret') 'Tracked fixture was overwritten with credentials.'
    }
    Invoke-Test 'Mismatched saved publish secret fails without overwriting either side' {
        $fixture = New-PublishFixture 'publish-mismatch'
        $first = Initialize-PublishConfiguration $fixture.Root $fixture.Private
        $secret = Join-Path $fixture.Private 'publish-runner-token.dpapi'
        $saved = [IO.File]::ReadAllText($secret)
        $changed = 'PUBLISH_RUNNER_TOKEN=' + (New-LocalPassword) + "`nPUBLISH_EXECUTION_MODE=local`n"
        [IO.File]::WriteAllText($fixture.Vars, $changed)
        Assert-Throws { Initialize-PublishConfiguration $fixture.Root $fixture.Private } 'differs'
        Assert-True ([IO.File]::ReadAllText($fixture.Vars) -ceq $changed -and [IO.File]::ReadAllText($secret) -ceq $saved) 'Mismatch recovery silently replaced a secret.'
    }
    Invoke-Test 'Weak and duplicate publish secrets reject without a recovery write' {
        foreach ($source in @('PUBLISH_RUNNER_TOKEN=short', "PUBLISH_RUNNER_TOKEN=first`nPUBLISH_RUNNER_TOKEN=second")) {
            $fixture = New-PublishFixture ('invalid-' + [Guid]::NewGuid().ToString('N'))
            [IO.File]::WriteAllText($fixture.Vars, $source)
            Assert-Throws { Initialize-PublishConfiguration $fixture.Root $fixture.Private } ''
            Assert-True ([IO.File]::ReadAllText($fixture.Vars) -ceq $source -and -not (Test-Path -LiteralPath (Join-Path $fixture.Private 'publish-runner-token.dpapi'))) 'Invalid secret was silently repaired or saved.'
        }
    }
    Invoke-Test 'Existing custom environment layers still block ambiguous initial setup' {
        $fixture = New-PublishFixture 'publish-env-override'
        [IO.File]::WriteAllText((Join-Path $fixture.Root 'worker/.env.local'), 'SETUP_TOKEN=unknown-precedence')
        Assert-Throws { Get-LocalSetupToken $fixture.Root } 'Custom worker environment detected'
    }

    $script:RealLocalDir = $LocalDir
    $script:RealRepoRoot = $RepoRoot
    $script:LocalDir = $script:PublishFixture.Private
    Set-TestFunction 'Get-CimInstance' {
        [CmdletBinding()]
        param([string]$ClassName, [string]$Filter)
        Assert-True ($ClassName -eq 'Win32_Process') 'Unexpected process query class.'
        if ($Filter -match '^ProcessId=([0-9]+)$') { return $script:ProcessTable[[int]$Matches[1]] }
        if ($Filter -match '^ParentProcessId=([0-9]+)$') { $parentNumber = [int]$Matches[1]; return @($script:ProcessTable.Values | Where-Object ParentProcessId -eq $parentNumber) }
        if ($Filter -eq "Name='powershell.exe'") { return @($script:ProcessTable.Values) }
        throw 'Process query was not restricted to an explicit identity or parent.'
    }
    Set-TestFunction 'Stop-Process' {
        [CmdletBinding()]
        param([int]$Id, [switch]$Force)
        Assert-True $Force 'Owned restart did not explicitly stop the selected process.'
        $script:Stopped.Add($Id)
        $script:ProcessTable.Remove($Id)
    }
    $script:ProcessTable = @{}
    $script:Stopped = New-Object 'Collections.Generic.List[int]'
    $script:Created = [DateTime]::UtcNow.AddMinutes(-5)
    $script:RunnerCommand = 'powershell.exe -NoProfile -File "' + $LauncherPath + '" -Service runner'
    Invoke-Test 'Runner supervisor record requires both command identity and creation time' {
        $script:ProcessTable[71001] = New-FakeProcess 71001 1 $script:RunnerCommand $script:Created
        @{ ProcessId = 71001; Created = $script:Created.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LocalDir 'runner-process.json')
        Assert-True ((Get-OwnedSupervisor 'runner').ProcessId -eq 71001) 'Recorded runner supervisor could not be reused.'
        $script:ProcessTable[71001].CreationDate = $script:Created.AddSeconds(1)
        Assert-True ($null -eq (Get-OwnedSupervisor 'runner')) 'Recycled runner PID was trusted.'
        $script:ProcessTable[71001].CreationDate = $script:Created
        $script:ProcessTable[71001].CommandLine = 'powershell.exe -File C:\foreign.ps1 -Label "' + $LauncherPath + '" -Service runner'
        Assert-True ($null -eq (Get-OwnedSupervisor 'runner')) 'A later label argument falsely claimed supervisor ownership.'
        $script:ProcessTable[71001].CommandLine = $script:RunnerCommand
    }
    Invoke-Test 'PowerShell command mode cannot impersonate a launcher through trailing file arguments' {
        foreach ($option in @('-Command', '-EncodedCommand', '-UnknownOption')) {
            $fake = New-FakeProcess 71999 1 ('powershell.exe ' + $option + ' synthetic -File "' + $LauncherPath + '" -Service runner') $script:Created
            Assert-True (-not (Test-LauncherProcess $fake 'runner')) 'A non-file PowerShell mode falsely claimed supervisor ownership.'
        }
    }
    Invoke-Test 'Repeat runner launch reuses its owned supervisor without spawning' {
        Start-LocalSupervisor 'runner'
        Start-LocalSupervisor 'runner'
        Assert-True ((Get-OwnedSupervisor 'runner').ProcessId -eq 71001) 'Repeat launch changed supervisor identity.'
        # The Start-Process fake installed at test entry still throws on any call.
    }
    Invoke-Test 'Truncated supervisor record is recovered only from an exact live launcher' {
        [IO.File]::WriteAllText((Join-Path $LocalDir 'runner-process.json'), '{')
        Assert-True ((Get-OwnedSupervisor 'runner').ProcessId -eq 71001) 'A truncated record stranded a proven live supervisor.'
        Assert-True (([IO.File]::ReadAllText((Join-Path $LocalDir 'runner-process.json')) | ConvertFrom-Json).ProcessId -eq 71001) 'Supervisor record was not repaired.'
    }
    Invoke-Test 'Invalid record fields recover without trusting the stored PID or timestamp' {
        foreach ($bad in @('{}', '{"ProcessId":71001,"Created":"not-a-date"}', '{"ProcessId":999999999999999999999,"Created":"2026-01-01"}')) {
            [IO.File]::WriteAllText((Join-Path $LocalDir 'runner-process.json'), $bad)
            Assert-True ((Get-OwnedSupervisor 'runner').ProcessId -eq 71001) 'Invalid metadata was not recovered from the exact live command.'
        }
    }
    Invoke-Test 'Creation-time mismatch forbids terminating a recycled PID' {
        $expected = New-FakeProcess 71002 1 'node.exe C:\owned\entry.js' $script:Created
        $script:ProcessTable[71002] = New-FakeProcess 71002 1 'node.exe C:\owned\entry.js' $script:Created.AddSeconds(1)
        Assert-Throws { Stop-VerifiedProcess $expected } 'identity changed'
        Assert-True ($script:Stopped.Count -eq 0 -and $script:ProcessTable.ContainsKey(71002)) 'A recycled PID was terminated.'
    }
    Invoke-Test 'Owned frontend refresh stops only its verified same-checkout supervisor tree' {
        $siteCommand = 'powershell.exe -NoProfile -File "' + $LauncherPath + '" -Service site'
        $script:ProcessTable = @{
            71500 = (New-FakeProcess 71500 71999 $siteCommand $script:Created)
            71501 = (New-FakeProcess 71501 71500 ('node.exe "' + (Get-ServiceDefinition 'site').Marker + 'astro/bin/astro.mjs" dev') $script:Created.AddSeconds(1))
            71999 = (New-FakeProcess 71999 0 'powershell.exe -File C:\unrelated.ps1' $script:Created.AddMinutes(-1))
        }
        $script:Stopped.Clear()
        @{ ProcessId = 71500; Created = $script:Created.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LocalDir 'site-process.json')
        Set-TestFunction 'Get-NetTCPConnection' {
            [CmdletBinding()]
            param([string]$State)
            if ($script:ProcessTable.ContainsKey(71501)) { return [pscustomobject]@{ LocalPort = 4321; LocalAddress = '127.0.0.1'; OwningProcess = 71501 } }
        }
        Restart-OwnedFrontendService 'site'
        Assert-True (($script:Stopped -join ',') -ceq '71500,71501') 'Frontend refresh did not stop its verified supervisor tree.'
        Assert-True ($script:ProcessTable.Count -eq 1 -and $script:ProcessTable.ContainsKey(71999)) 'Frontend refresh stopped an unrelated process.'
    }
    Invoke-Test 'Frontend refresh accepts an owned listener that exits between identity reads' {
        $script:ProcessTable = @{ 71601 = (New-FakeProcess 71601 71600 ('node.exe "' + (Get-ServiceDefinition 'site').Marker + 'astro/bin/astro.mjs" dev') $script:Created) }
        $script:ListenerReads = 0
        Set-TestFunction 'Get-NetTCPConnection' {
            [CmdletBinding()]
            param([string]$State)
            $script:ListenerReads++
            if ($script:ListenerReads -eq 2) { $script:ProcessTable.Remove(71601) }
            if ($script:ListenerReads -le 2) { return [pscustomobject]@{ LocalPort = 4321; LocalAddress = '127.0.0.1'; OwningProcess = 71601 } }
        }
        Restart-OwnedFrontendService 'site'
        Assert-True ($script:ListenerReads -eq 3) 'A vanished owned listener was not rechecked before accepting the completed refresh.'
    }
    Invoke-Test 'Astro daemon refresh stops its verified orphan listener without a live supervisor' {
        $script:ProcessTable = @{
            71701 = (New-FakeProcess 71701 71700 ('node.exe "' + (Get-ServiceDefinition 'site').Marker + 'astro/bin/astro.mjs" dev --port 4321 --host 127.0.0.1 --json') $script:Created)
        }
        $script:Stopped.Clear()
        Remove-Item -LiteralPath (Join-Path $LocalDir 'site-process.json') -ErrorAction SilentlyContinue
        Set-TestFunction 'Get-NetTCPConnection' {
            [CmdletBinding()]
            param([string]$State)
            if ($script:ProcessTable.ContainsKey(71701)) { return [pscustomobject]@{ LocalPort = 4321; LocalAddress = '127.0.0.1'; OwningProcess = 71701 } }
        }
        Restart-OwnedFrontendService 'site'
        Assert-True (($script:Stopped -join ',') -ceq '71701' -and $script:ProcessTable.Count -eq 0) 'Verified Astro daemon listener was left running or an unrelated process was stopped.'
    }
    Invoke-Test 'Owned API reload stops only its verified supervisor tree' {
        $apiCommand = 'powershell.exe -NoProfile -File "' + $LauncherPath + '" -Service api'
        $script:ProcessTable = @{
            72000 = (New-FakeProcess 72000 72999 $apiCommand $script:Created)
            72001 = (New-FakeProcess 72001 72000 'node.exe C:\global-npm\npm-cli.js run dev' $script:Created.AddSeconds(1))
            72002 = (New-FakeProcess 72002 72001 ('node.exe "' + (Get-ServiceDefinition 'api').Marker + 'wrangler/bin/wrangler.js" dev') $script:Created.AddSeconds(2))
            72999 = (New-FakeProcess 72999 0 'powershell.exe -File C:\unrelated.ps1' $script:Created.AddMinutes(-1))
        }
        $script:Stopped.Clear()
        @{ ProcessId = 72000; Created = $script:Created.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LocalDir 'api-process.json')
        Set-TestFunction 'Get-NetTCPConnection' {
            [CmdletBinding()]
            param([string]$State)
            if ($script:ProcessTable.ContainsKey(72002)) { return [pscustomobject]@{ LocalPort = 8787; LocalAddress = '127.0.0.1'; OwningProcess = 72002 } }
        }
        Stop-OwnedApi
        Assert-True (($script:Stopped -join ',') -ceq '72000,72001,72002') 'Owned API process tree was not stopped in parent-first order.'
        Assert-True ($script:ProcessTable.Count -eq 1 -and $script:ProcessTable.ContainsKey(72999)) 'Reload stopped an unrelated ancestor.'
    }
    Invoke-Test 'Foreign API listener prevents all reload termination' {
        $script:Stopped.Clear()
        $script:ProcessTable[72002] = New-FakeProcess 72002 72999 'node.exe C:\unrelated-project\server.js' $script:Created
        Assert-Throws { Stop-OwnedApi } 'occupied by another'
        Assert-True ($script:Stopped.Count -eq 0) 'Foreign listener triggered process termination.'
    }
    Invoke-Test 'Shared Wrangler installation with an external configuration is never stopped' {
        $script:Stopped.Clear()
        $script:ProcessTable[72002] = New-FakeProcess 72002 72999 ('node.exe "' + (Get-ServiceDefinition 'api').Marker + 'wrangler/bin/wrangler.js" dev --config C:\unrelated-project\wrangler.toml') $script:Created
        Assert-Throws { Stop-OwnedApi } 'supervisor'
        Assert-True ($script:Stopped.Count -eq 0) 'Shared binary location authorized stopping an external project.'
        Assert-Throws { Get-PublishRunnerState 'synthetic-token-never-send-to-foreign-service' } 'supervisor'
    }

    Set-TestFunction 'Get-OwnedListener' { return [pscustomobject]@{ OwningProcess = 72002 } }
    Set-TestFunction 'Get-VerifiedApiSupervisor' { return @{ ProcessId = 72000 } }
    Set-TestFunction 'Invoke-LocalApi' {
        param([string]$BaseUri, [string]$Path, [string]$Method, $Body, [string]$Cookie, [string]$BearerToken)
        Assert-True ($BaseUri -ceq 'http://127.0.0.1:8787' -and $Path -in @('/api/publish/runner-state', '/api/publish/runner-state?readiness=1') -and $Method -ceq 'GET') 'Runner readiness used an unexpected API route.'
        Assert-True (-not $Cookie -and $BearerToken -ceq $script:ExpectedPublishToken -and $null -eq $Body) 'Runner readiness borrowed a password/session or lost its independent bearer.'
        if ($Path -ceq '/api/publish/runner-state?readiness=1') {
            return @{ Status = $script:RunnerApiStatus; Json = [pscustomobject]@{
                protocol = 1; environment = 'dev'; mode = 'local'; storageReady = $script:StorageReady
                restartSafe = (-not $script:StorageReady); activeVersion = $null; requiredMigration = '0021_publish_checks.sql'
            } }
        }
        return @{ Status = $script:RunnerApiStatus; Json = @{ environment = 'dev'; executor = @{ mode = 'local'; ready = $true } } }
    }
    $script:ExpectedPublishToken = New-LocalPassword
    $script:RunnerApiStatus = 200
    $script:StorageReady = $true
    Invoke-Test 'Publish readiness authenticates only with its dedicated bearer' {
        Assert-True (Get-PublishRunnerState $script:ExpectedPublishToken).executor.ready 'Dedicated runner readiness failed.'
        $script:RunnerApiStatus = 401
        Assert-Throws { Get-PublishRunnerState $script:ExpectedPublishToken } 'not loaded'
        $script:RunnerApiStatus = 200
    }
    Set-TestFunction 'Stop-OwnedApi' { $script:ReloadEvents.Add('stop-owned'); $script:StorageReady = $true }
    Set-TestFunction 'Ensure-LocalService' { param([string]$Name); $script:ReloadEvents.Add('start-' + $Name) }
    $script:ReloadEvents = New-Object 'Collections.Generic.List[string]'
    Invoke-Test 'A verified idle API with missing schema is reloaded once and then reused' {
        $script:StorageReady = $false
        Ensure-PublishApi $script:ExpectedPublishToken
        Ensure-PublishApi $script:ExpectedPublishToken
        Assert-True (($script:ReloadEvents -join ',') -ceq 'stop-owned,start-api') 'API reload was skipped or repeated after authenticated readiness succeeded.'
    }
    Invoke-Test 'Authentication failure cannot authorize stopping an API with unknown job state' {
        $script:ReloadEvents.Clear()
        $script:RunnerApiStatus = 401
        Assert-Throws { Ensure-PublishApi $script:ExpectedPublishToken } 'HTTP 401'
        Assert-True ($script:ReloadEvents.Count -eq 0) 'Authentication failure authorized an API restart.'
        $script:RunnerApiStatus = 200
    }
    Invoke-Test 'API ownership failure aborts reload before launching a replacement' {
        $script:ReloadEvents.Clear()
        $script:StorageReady = $false
        Set-TestFunction 'Stop-OwnedApi' { throw 'Unowned service must remain running.' }
        Assert-Throws { Ensure-PublishApi $script:ExpectedPublishToken } 'Unowned service'
        Assert-True ($script:ReloadEvents.Count -eq 0) 'Replacement API started despite rejected ownership.'
        $script:StorageReady = $true
    }
    Invoke-Test 'Runner receives the dedicated secret but no administrator password or cookie' {
        $names = @('PUBLISH_RUNNER_TOKEN', 'PUBLISH_API_URL', 'PUBLISH_COOKIE', 'COOKIE', 'ADMIN_PASSWORD', 'PUBLISH_PASSWORD', 'SETUP_TOKEN', 'AI_CREDENTIAL_ENCRYPTION_KEY', 'AI_TICK_TOKEN', 'OPENAI_API_KEY', 'ai_future_secret')
        $previous = @{}
        foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, 'synthetic-inherited-value', 'Process') }
        Set-TestFunction 'Invoke-Npm' {
            param([string]$Directory, [string[]]$Arguments)
            Assert-True ($Directory -ieq (Join-Path $RepoRoot 'worker') -and ($Arguments -join ' ') -ceq 'run publish:runner') 'Runner command contains unexpected arguments.'
            Assert-True ($env:PUBLISH_RUNNER_TOKEN -ceq (Read-LocalPassword (Join-Path $LocalDir 'publish-runner-token.dpapi')) -and $env:PUBLISH_API_URL -ceq 'http://127.0.0.1:8787') 'Runner did not receive its own dedicated configuration.'
            foreach ($name in @('PUBLISH_COOKIE', 'COOKIE', 'ADMIN_PASSWORD', 'PUBLISH_PASSWORD', 'SETUP_TOKEN')) { Assert-True (-not [Environment]::GetEnvironmentVariable($name, 'Process')) 'Administrator credentials leaked to the runner environment.' }
            Assert-True (@([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -match '^(AI_|OPENAI_)' }).Count -eq 0) 'AI credentials leaked to the runner environment.'
        }
        try {
            Invoke-PublishRunner
            foreach ($name in $names) { Assert-True ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq 'synthetic-inherited-value') 'Runner invocation did not restore its parent environment.' }
        } finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
    }
    Invoke-Test 'Runner supervisor restarts exits with bounded backoff' {
        $script:RunnerStarts = 0
        $script:RestartDelays = New-Object 'Collections.Generic.List[int]'
        Set-TestFunction 'Invoke-PublishRunner' { $script:RunnerStarts++; if ($script:RunnerStarts -eq 1) { throw 'Synthetic runner crash.' } }
        Set-TestFunction 'Start-Sleep' { param([int]$Seconds); $script:RestartDelays.Add($Seconds); if ($script:RestartDelays.Count -eq 2) { throw 'End synthetic supervisor loop.' } }
        Assert-Throws { Invoke-PublishSupervisor } 'End synthetic supervisor loop'
        Assert-True ($script:RunnerStarts -eq 2 -and ($script:RestartDelays -join ',') -ceq '3,6') 'Runner exit was not retried with bounded backoff.'
    }
    Invoke-Test 'Runner startup is not ready until an actual heartbeat arrives' {
        $script:RunnerChecks = 0
        $script:SupervisorRequests = 0
        Set-TestFunction 'Start-LocalSupervisor' { param([string]$Name); Assert-True ($Name -ceq 'runner') 'Unexpected supervisor.'; $script:SupervisorRequests++ }
        Set-TestFunction 'Get-OwnedSupervisor' { return @{ ProcessId = 71001 } }
        Set-TestFunction 'Get-PublishRunnerState' { $script:RunnerChecks++; return @{ executor = @{ ready = ($script:RunnerChecks -ge 2) } } }
        Set-TestFunction 'Start-Sleep' { }
        Ensure-PublishRunner $script:ExpectedPublishToken
        Assert-True ($script:RunnerChecks -eq 2 -and $script:SupervisorRequests -eq 1) 'Runner readiness ignored its heartbeat or spawned duplicates.'
    }
    Invoke-Test 'One-click startup preserves NoBrowser and opens the published site and console' {
        $fixture = New-PublishFixture 'whole-startup'
        foreach ($relative in @('node_modules/astro/bin/astro.mjs', 'admin/node_modules/vite/bin/vite.js', 'worker/node_modules/wrangler/bin/wrangler.js', 'schema/node_modules/zod/package.json', 'dist-live/index.html', 'dist-live/admin/index.html')) {
            $path = Join-Path $fixture.Root $relative
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
            [IO.File]::WriteAllText($path, 'synthetic-fixture')
        }
        $script:RepoRoot = $fixture.Root
        $script:LocalDir = $fixture.Private
        $script:NoBrowser = $true
        $script:HidePassword = $true
        $script:NonInteractive = $true
        $script:StartupEvents = New-Object 'Collections.Generic.List[string]'
        $script:OpenedUrls = New-Object 'Collections.Generic.List[string]'
        Set-TestFunction 'Start-Process' { param([string]$FilePath); $script:OpenedUrls.Add($FilePath) }
        Set-TestFunction 'Initialize-PublishConfiguration' { $script:StartupEvents.Add('publish-config'); return @{ Token = 'synthetic-dedicated-publish-token-for-startup' } }
        Set-TestFunction 'Restart-OwnedFrontendService' { param([string]$Name); $script:StartupEvents.Add('refresh-' + $Name) }
        Set-TestFunction 'Ensure-LocalService' { param([string]$Name); $script:StartupEvents.Add($Name) }
        Set-TestFunction 'Ensure-PublishApi' { $script:StartupEvents.Add('api-authenticated') }
        Set-TestFunction 'Initialize-LocalAdmin' { $script:StartupEvents.Add('admin-login'); return @{ Created = $false; Password = 'synthetic-admin' } }
        Set-TestFunction 'Ensure-PublishRunner' { $script:StartupEvents.Add('runner-ready') }
        Start-Website
        Assert-True (($script:StartupEvents -join ',') -ceq 'publish-config,api,api-authenticated,refresh-site,site,refresh-admin,admin,admin-login,runner-ready') 'One-click startup did not refresh both code surfaces before readiness, or omitted a managed service.'
        Assert-True ($script:OpenedUrls.Count -eq 0) 'NoBrowser still opened a browser.'
        # Missing schema dependencies must install in that package using its lock.
        Remove-Item -LiteralPath (Join-Path $fixture.Root 'schema/node_modules/zod/package.json')
        $script:SchemaInstalls = 0
        Set-TestFunction 'Invoke-Npm' {
            param([string]$Directory, [string[]]$Arguments)
            Assert-True ($Directory -ceq (Join-Path $script:RepoRoot 'schema') -and ($Arguments -join ' ') -ceq 'ci --no-audit --no-fund') 'Missing schema invoked an unexpected package or command.'
            $script:SchemaInstalls++
        }
        $script:NoBrowser = $false
        Start-Website
        Assert-True ($script:SchemaInstalls -eq 1) 'Missing schema dependencies were not installed.'
        Assert-True (($script:OpenedUrls -join ',') -ceq 'http://127.0.0.1:8787/,http://127.0.0.1:5175/admin/') 'Startup opened an unpublished preview instead of the published website and console.'
    }
    Invoke-Test 'Publish upgrade capability and restart safety regressions' {
        $suite = Join-Path (Split-Path -Parent $script:LauncherUnderTest) 'scripts/test-publish-upgrade.ps1'
        & $WindowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $suite
        Assert-True ($LASTEXITCODE -eq 0) 'Publish upgrade capability regression suite failed.'
    }

    Set-TestFunction 'Start-Process' { throw 'Regression tests must never start a process.' }
    $script:NoBrowser = $true
    $script:RepoRoot = $script:RealRepoRoot
    $script:LocalDir = $script:RealLocalDir

    Invoke-Test 'AI tick initializes durably without creating an unverified encryption root' {
        $fixture = New-PublishFixture 'ai-first-tick'
        $first = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
        $tickBytes = [IO.File]::ReadAllText($paths.Tick)
        $varsBytes = [IO.File]::ReadAllText($paths.Vars)
        Assert-True ($first.Token.Length -ge 32 -and $first.BootstrapAllowed -and -not $first.RootAvailable) 'Tick bootstrap did not wait for D1 inspection.'
        Assert-True (-not (Test-Path -LiteralPath $paths.RootKey) -and -not (Test-Path -LiteralPath $paths.Marker)) 'An encryption root was created before D1 inspection.'
        $again = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        Assert-True ($again.Token -ceq $first.Token -and [IO.File]::ReadAllText($paths.Tick) -ceq $tickBytes -and [IO.File]::ReadAllText($paths.Vars) -ceq $varsBytes) 'Repeated startup rotated or rewrote the tick secret.'
        Assert-True ($tickBytes.IndexOf($first.Token, [StringComparison]::Ordinal) -lt 0 -and (Read-LocalPassword $paths.Tick) -ceq $first.Token) 'Tick recovery was not DPAPI protected.'
        Assert-True (Get-Acl -LiteralPath $paths.Vars).AreAccessRulesProtected 'AI plaintext binding inherited access rules.'
    }
    Set-TestFunction 'Get-AiBootstrapState' {
        param([string]$Token)
        $script:AiBootstrapCalls++
        if ($script:AiBootstrapMode -eq 'unavailable') { throw 'Synthetic bootstrap failure.' }
        return @{ initialized = ($script:AiBootstrapMode -eq 'initialized'); hasCredential = ($script:AiBootstrapMode -eq 'credential'); encryptionReady = ($script:AiBootstrapMode -eq 'loaded' -and $script:AiBootstrapCalls -gt 1) }
    }
    Invoke-Test 'AI root requires empty D1 then persists once and proves actual Worker loading' {
        $fixture = New-PublishFixture 'ai-root-fresh'
        $config = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        $script:AiBootstrapMode = 'loaded'; $script:AiBootstrapCalls = 0
        Assert-True (Complete-AiBootstrap $fixture.Root $fixture.Private $config) 'Runtime-confirmed root was not ready.'
        $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
        $key = Read-LocalPassword $paths.RootKey
        Assert-AiEncryptionKey $key
        Assert-True ((Get-DevVariable ([IO.File]::ReadAllText($paths.Vars)) 'AI_CREDENTIAL_ENCRYPTION_KEY') -ceq $key -and (Test-Path -LiteralPath $paths.Marker)) 'Persisted root and Worker binding differ.'
        $ciphertext = [IO.File]::ReadAllText($paths.RootKey); $vars = [IO.File]::ReadAllText($paths.Vars)
        Assert-True ($ciphertext.IndexOf($key, [StringComparison]::Ordinal) -lt 0) 'Root recovery contains plaintext.'
        $again = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        Assert-True ($again.RootAvailable -and -not $again.BootstrapAllowed -and [IO.File]::ReadAllText($paths.RootKey) -ceq $ciphertext -and [IO.File]::ReadAllText($paths.Vars) -ceq $vars) 'Repeated startup regenerated an existing encryption root.'
    }
    Invoke-Test 'AI root is never generated for initialized D1, ciphertext or unavailable bootstrap' {
        foreach ($mode in @('initialized', 'credential', 'unavailable')) {
            $fixture = New-PublishFixture ('ai-d1-' + $mode)
            $config = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
            $script:AiBootstrapMode = $mode; $script:AiBootstrapCalls = 0
            if ($mode -eq 'unavailable') { Assert-Throws { Complete-AiBootstrap $fixture.Root $fixture.Private $config } 'Synthetic bootstrap' }
            else { Assert-True (-not (Complete-AiBootstrap $fixture.Root $fixture.Private $config)) 'Existing D1 encryption state was ignored.' }
            $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
            Assert-True (-not (Test-Path -LiteralPath $paths.RootKey) -and -not (Test-Path -LiteralPath $paths.Marker) -and $null -eq (Get-DevVariable ([IO.File]::ReadAllText($paths.Vars)) 'AI_CREDENTIAL_ENCRYPTION_KEY')) 'A missing root was silently replaced.'
        }
    }
    Invoke-Test 'Local initialization marker prevents root regeneration even with empty D1' {
        $fixture = New-PublishFixture 'ai-missing-root'
        [void](Initialize-AiLocalConfiguration $fixture.Root $fixture.Private)
        $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
        Save-AiInitializationMarker $paths.Marker
        $config = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        $script:AiBootstrapMode = 'empty'; $script:AiBootstrapCalls = 0
        Assert-True (-not $config.BootstrapAllowed -and -not (Complete-AiBootstrap $fixture.Root $fixture.Private $config)) 'A local initialization marker was ignored.'
        Assert-True (-not (Test-Path -LiteralPath $paths.RootKey)) 'Lost encryption root was silently regenerated.'
    }
    Invoke-Test 'Unloaded root does not claim readiness or restart the API' {
        $fixture = New-PublishFixture 'ai-await-runtime'
        $config = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
        $script:AiBootstrapMode = 'empty'; $script:AiBootstrapCalls = 0
        Assert-True (-not (Complete-AiBootstrap $fixture.Root $fixture.Private $config) -and $config.Status -ceq 'awaiting-normal-api-restart') 'Disk persistence was mistaken for Worker loading.'
        $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
        $ciphertext = [IO.File]::ReadAllText($paths.RootKey)
        $script:AiBootstrapMode = 'loaded'
        Assert-True (Complete-AiBootstrap $fixture.Root $fixture.Private $config) 'A later confirmed reload did not become ready.'
        Assert-True ([IO.File]::ReadAllText($paths.RootKey) -ceq $ciphertext) 'A later runtime check rotated the root.'
    }
    Invoke-Test 'Root recovery restores exact DPAPI bytes and refuses mismatches or corrupted recovery' {
        foreach ($mode in @('restore', 'mismatch', 'corrupt')) {
            $fixture = New-PublishFixture ('ai-recovery-' + $mode)
            [void](Initialize-AiLocalConfiguration $fixture.Root $fixture.Private)
            $paths = Get-AiLocalPaths $fixture.Root $fixture.Private
            $rootKey = [Convert]::ToBase64String((New-Object byte[] 32))
            if ($mode -eq 'corrupt') { [IO.File]::WriteAllText($paths.RootKey, 'not-a-dpapi-envelope') }
            else { Save-LocalPassword $paths.RootKey $rootKey }
            if ($mode -eq 'mismatch') { Write-AiDevVariables $fixture.Root $fixture.Private @{ AI_CREDENTIAL_ENCRYPTION_KEY = [Convert]::ToBase64String(([byte[]](1..32))) } }
            $before = [IO.File]::ReadAllText($paths.RootKey)
            $config = Initialize-AiLocalConfiguration $fixture.Root $fixture.Private
            if ($mode -eq 'restore') { Assert-True ($config.RootAvailable -and (Get-DevVariable ([IO.File]::ReadAllText($paths.Vars)) 'AI_CREDENTIAL_ENCRYPTION_KEY') -ceq $rootKey) 'Recovery changed the root bytes.' }
            else { Assert-True (-not $config.RootAvailable -and -not $config.BootstrapAllowed -and $config.Status -ceq 'encryption-recovery-required') 'Invalid recovery was not isolated from website startup.' }
            Assert-True ([IO.File]::ReadAllText($paths.RootKey) -ceq $before) 'Recovery silently overwrote existing ciphertext.'
        }
    }
    Invoke-Test 'AI preparation refuses tracked private paths before writing secrets' {
        $fixture = New-PublishFixture 'ai-tracked-vars'
        [IO.File]::WriteAllText($fixture.Vars, 'CUSTOM_SETTING=synthetic')
        & (Get-Command git.exe).Source -C $script:TemporaryRoot add --force -- $fixture.Vars
        Assert-Throws { Initialize-AiLocalConfiguration $fixture.Root $fixture.Private } 'not ignored by Git'
        Assert-True ([IO.File]::ReadAllText($fixture.Vars) -ceq 'CUSTOM_SETTING=synthetic' -and -not (Test-Path -LiteralPath (Join-Path $fixture.Private 'ai-tick-token.dpapi'))) 'Rejected private path received a secret.'
    }
    Invoke-Test 'AI preparation rejects a real linked private directory without touching its target' {
        $fixture = New-PublishFixture 'ai-linked-private'
        $target = Join-Path $fixture.Root 'untouched-target'
        [void][IO.Directory]::CreateDirectory($target)
        [void](New-Item -ItemType Junction -Path $fixture.Private -Target $target)
        try {
            Assert-Throws { Initialize-AiLocalConfiguration $fixture.Root $fixture.Private } 'link'
            Assert-True (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0 -and -not (Test-Path -LiteralPath $fixture.Vars)) 'Linked directory rejection wrote a secret.'
        } finally { Remove-Item -LiteralPath $fixture.Private -Force }
    }
    Set-Item -LiteralPath 'Function:script:Get-AiBootstrapState' -Value $script:SavedFunctions['Get-AiBootstrapState']
    Set-TestFunction 'Get-VerifiedApiSupervisor' { return @{ ProcessId = $script:AiOwner } }
    Set-TestFunction 'Invoke-LocalApi' {
        param([string]$BaseUri, [string]$Path, [string]$Method, $Body, [string]$Cookie, [string]$BearerToken, [int]$TimeoutSeconds)
        $script:AiHttpCalls++
        Assert-True ($BaseUri -ceq 'http://127.0.0.1:8787' -and -not $Cookie -and $null -eq $Body -and $BearerToken -ceq 'synthetic-ai-tick-token-32-characters') 'AI request destination, body or authentication is incorrect.'
        if ($Path -ceq '/api/internal/translations/tick') { Assert-True ($Method -ceq 'POST' -and $TimeoutSeconds -eq 55) 'Tick must leave the NVIDIA request enough time while remaining bounded.'; return @{ Status = 200; Json = @{ skipped = $true } } }
        Assert-True ($Path -ceq '/api/internal/translations/bootstrap' -and $Method -ceq 'GET' -and $TimeoutSeconds -eq 5) 'Bootstrap request is incorrect.'
        return @{ Status = 200; Json = @{ initialized = $false; hasCredential = $false; encryptionReady = $script:AiReadyValue } }
    }
    Invoke-Test 'AI requests require the current supervisor before any bearer send' {
        $script:AiHttpCalls = 0; $script:AiOwner = $PID + 1; $script:AiReadyValue = $false
        Assert-Throws { Invoke-AiTranslationTick 'synthetic-ai-tick-token-32-characters' } 'not owned'
        Assert-Throws { Get-AiBootstrapState 'synthetic-ai-tick-token-32-characters' } 'not owned'
        Assert-True ($script:AiHttpCalls -eq 0) 'AI bearer was sent before ownership was proved.'
        $script:AiOwner = $PID
        [void](Get-AiBootstrapState 'synthetic-ai-tick-token-32-characters')
        [void](Invoke-AiTranslationTick 'synthetic-ai-tick-token-32-characters')
        Assert-True ($script:AiHttpCalls -eq 2) 'Owned API calls did not use their bounded contracts.'
        $script:AiReadyValue = 'false'
        Assert-Throws { Get-AiBootstrapState 'synthetic-ai-tick-token-32-characters' } 'unavailable'
    }
    Invoke-Test 'Real HttpClient sends empty bearer requests without cookies, redirects or unbounded waits' {
        $fixture = New-PublishFixture 'ai-http-sentinel'
        $serverPath = Join-Path $fixture.Root 'server.cjs'
        $serverSource = @'
const fs = require('node:fs');
const http = require('node:http');
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    seen.push({ path: req.url, method: req.method, bearerMatches: req.headers.authorization === 'Bearer synthetic-ai-http-token', hasCookie: !!req.headers.cookie, bodyLength: body.length });
    fs.writeFileSync('seen.json', JSON.stringify(seen));
    if (req.url === '/redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end(); return; }
    if (req.url === '/hung') return;
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('port.txt', String(server.address().port)));
'@
        [IO.File]::WriteAllText($serverPath, $serverSource)
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = (Get-Command node.exe).Source; $info.Arguments = '"' + $serverPath + '"'
        $info.WorkingDirectory = $fixture.Root; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        foreach ($name in @($info.EnvironmentVariables.Keys)) { if ($name -match '^(AI_|OPENAI_)') { $info.EnvironmentVariables.Remove($name) } }
        $server = [Diagnostics.Process]::Start($info)
        try {
            $portPath = Join-Path $fixture.Root 'port.txt'; $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while (-not (Test-Path -LiteralPath $portPath) -and [DateTime]::UtcNow -lt $deadline) { [Threading.Thread]::Sleep(20) }
            Assert-True (Test-Path -LiteralPath $portPath) 'Isolated HTTP fixture did not start.'
            $baseUri = 'http://127.0.0.1:' + [IO.File]::ReadAllText($portPath)
            $actualHttp = $script:SavedFunctions['Invoke-LocalApi']
            $reply = & $actualHttp $baseUri '/tick' 'POST' $null '' 'synthetic-ai-http-token' 55
            Assert-True ($reply.Status -eq 200) 'Real empty POST failed.'
            $reply = & $actualHttp $baseUri '/redirect' 'POST' $null '' 'synthetic-ai-http-token' 30
            Assert-True ($reply.Status -eq 302) 'HTTP redirect was followed.'
            $watch = [Diagnostics.Stopwatch]::StartNew()
            Assert-Throws { & $actualHttp $baseUri '/hung' 'POST' $null '' 'synthetic-ai-http-token' 1 } ''
            Assert-True ($watch.Elapsed.TotalSeconds -lt 5) 'HTTP timeout was not enforced.'
            $seen = [IO.File]::ReadAllText((Join-Path $fixture.Root 'seen.json')) | ConvertFrom-Json
            Assert-True ($seen.Count -eq 3 -and ($seen.path -join ',') -ceq '/tick,/redirect,/hung') 'HTTP client sent an unexpected follow-up request.'
            foreach ($request in $seen) { Assert-True ($request.method -ceq 'POST' -and $request.bearerMatches -and -not $request.hasCookie -and $request.bodyLength -eq 0) 'HTTP body or authentication leaked outside its contract.' }
        } finally { if (-not $server.HasExited) { $server.Kill(); [void]$server.WaitForExit(5000) }; $server.Dispose() }
    }
    Invoke-Test 'Real npm API and build children cannot inherit AI or OpenAI environment secrets' {
        $fixture = New-PublishFixture 'ai-process-sentinel'
        [IO.File]::WriteAllText((Join-Path $fixture.Root 'worker/package.json'), '{"scripts":{"dev":"node probe.cjs"}}')
        [IO.File]::WriteAllText((Join-Path $fixture.Root 'worker/probe.cjs'), 'require("node:fs").writeFileSync("probe.json",JSON.stringify({names:Object.keys(process.env).filter(n=>/^(AI_|OPENAI_)/i.test(n)),keep:process.env.KEEP_AI_TEST,args:process.argv.slice(2)}));console.log("safe-api-stdout-probe");console.error("safe-api-stderr-probe")')
        $names = @('AI_CREDENTIAL_ENCRYPTION_KEY', 'AI_TICK_TOKEN', 'OPENAI_API_KEY', 'ai_future_secret', 'KEEP_AI_TEST')
        $previous = @{}; $originalRoot = $script:RepoRoot; $originalPrivate = $script:LocalDir
        foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, 'synthetic-ai-sentinel', 'Process') }
        try {
            $script:RepoRoot = $fixture.Root
            $script:LocalDir = $fixture.Private
            $child = Start-ApiChild
            try { Assert-True ($child.WaitForExit(15000) -and $child.ExitCode -eq 0) 'Isolated npm API child failed.' } finally { if (-not $child.HasExited) { $child.Kill() }; $child.Dispose() }
            $observed = [IO.File]::ReadAllText((Join-Path $fixture.Root 'worker/probe.json')) | ConvertFrom-Json
            Assert-True ($observed.names.Count -eq 0 -and $observed.keep -ceq 'synthetic-ai-sentinel' -and ($observed.args -join ' ') -ceq '--ip 127.0.0.1 --port 8787') 'API child inherited AI secrets or changed its loopback command.'
            $stdout = @(Get-ChildItem -LiteralPath $fixture.Private -Filter 'api-child-*.out.log'); $stderr = @(Get-ChildItem -LiteralPath $fixture.Private -Filter 'api-child-*.err.log')
            Assert-True ($stdout.Count -eq 1 -and [IO.File]::ReadAllText($stdout[0].FullName).Contains('safe-api-stdout-probe') -and $stderr.Count -eq 1 -and [IO.File]::ReadAllText($stderr[0].FullName).Contains('safe-api-stderr-probe')) 'Hidden API child lost its runtime logs.'
            & $script:SavedFunctions['Invoke-Npm'] -Directory (Join-Path $fixture.Root 'worker') -Arguments @('run', 'dev')
            $observed = [IO.File]::ReadAllText((Join-Path $fixture.Root 'worker/probe.json')) | ConvertFrom-Json
            Assert-True ($observed.names.Count -eq 0 -and $observed.keep -ceq 'synthetic-ai-sentinel') 'Ordinary build child inherited AI secrets.'
            foreach ($name in $names) { Assert-True ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq 'synthetic-ai-sentinel') 'Child startup changed its parent environment.' }
        } finally { $script:RepoRoot = $originalRoot; $script:LocalDir = $originalPrivate; foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
    }
    Invoke-Test 'Supervisor launch filters AI credentials and restores its parent environment after failure' {
        $names = @('AI_CREDENTIAL_ENCRYPTION_KEY', 'AI_TICK_TOKEN', 'OPENAI_API_KEY', 'ai_future_secret')
        $previous = @{}
        foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, 'synthetic-supervisor-sentinel', 'Process') }
        Set-TestFunction 'Get-OwnedSupervisor' { return $null }
        Set-TestFunction 'Start-Process' {
            Assert-True (@([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -match '^(AI_|OPENAI_)' }).Count -eq 0) 'AI credentials reached a new supervisor environment.'
            throw 'Synthetic supervisor launch failure.'
        }
        try {
            Assert-Throws { & $script:SavedFunctions['Start-LocalSupervisor'] 'api' } 'Synthetic supervisor launch failure'
            foreach ($name in $names) { Assert-True ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq 'synthetic-supervisor-sentinel') 'Failed supervisor launch did not restore its parent environment.' }
        } finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
    }
    Set-TestFunction 'Initialize-AiLocalConfiguration' { $script:AiConfigCalls++; if ($script:AiConfigFails) { throw 'Synthetic configuration failure.' }; return [pscustomobject]@{ Token = 'synthetic'; Status = 'awaiting-runtime-check' } }
    Set-TestFunction 'Get-OwnedListener' { return @() }
    Set-TestFunction 'Start-ApiChild' { $script:AiChildStarts++; return $script:AiFakeChild }
    Set-TestFunction 'Wait-ApiChild' { param($Child, [int]$Milliseconds); $script:AiWaits++; Assert-True ($Milliseconds -eq 1000) 'API supervision used an unbounded wait.'; return ($script:AiWaits -gt 131) }
    Set-TestFunction 'Get-AiTickTime' { return ([DateTime]'2026-01-01T00:00:00Z').AddSeconds($script:AiWaits) }
    Set-TestFunction 'Complete-AiBootstrap' { param($Root, $Private, $Config); $script:AiBootstrapChecks++; $Config.Status = 'ready'; return $true }
    Set-TestFunction 'Invoke-AiTranslationTick' { $script:AiTicks.Add($script:AiWaits); if ($script:AiTicks.Count -eq 1) { throw 'Synthetic tick timeout.' }; return @{ skipped = $true } }
    Invoke-Test 'API session ticks at most once per minute and disposes its child despite AI failure' {
        foreach ($failure in @($false, $true)) {
            $script:AiConfigFails = $failure; $script:AiChildStarts = 0; $script:AiWaits = 0; $script:AiDisposed = $false; $script:AiBootstrapChecks = 0
            $script:AiTicks = New-Object 'Collections.Generic.List[int]'
            $script:AiFakeChild = [pscustomobject]@{ ExitCode = 0 }
            $script:AiFakeChild | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:AiDisposed = $true }
            $configuration = if ($failure) { $null } else { [pscustomobject]@{ Token = 'synthetic'; Status = 'awaiting-runtime-check' } }
            Invoke-ApiSession $configuration
            Assert-True ($script:AiChildStarts -eq 1 -and $script:AiDisposed) 'AI failure changed API child lifecycle or leaked the process handle.'
            if ($failure) { Assert-True ($script:AiTicks.Count -eq 0) 'Unconfigured AI still sent ticks.' }
            else { Assert-True (($script:AiTicks -join ',') -ceq '1,61,121' -and $script:AiBootstrapChecks -eq 1) 'Tick failure changed cadence or re-ran a completed bootstrap.' }
        }
        $script:AiConfigFails = $true; $script:AiChildStarts = 0; $script:AiWaits = 131; $script:AiFakeChild.ExitCode = 7
        Assert-Throws { Invoke-ApiSession $null } 'exit 7'
        Assert-True ($script:AiChildStarts -eq 1 -and $script:AiDisposed) 'API session hid a failed child or leaked its handle.'
    }
    Invoke-Test 'API supervisor retries normal and failed exits with capped backoff and initializes credentials once' {
        foreach ($configurationFails in @($false, $true)) {
            $script:AiConfigFails = $configurationFails; $script:AiConfigCalls = 0; $script:AiChildStarts = 0; $script:AiDisposedCount = 0
            $script:AiRestartDelays = New-Object 'Collections.Generic.List[int]'
            $script:AiLifecycle = New-Object 'Collections.Generic.List[string]'
            $script:AiClock = [DateTime]'2026-01-01T00:00:00Z'
            Set-TestFunction 'Get-AiTickTime' { return $script:AiClock }
            Set-TestFunction 'Start-ApiChild' {
                $script:AiChildStarts++; $script:AiLifecycle.Add('start')
                $child = [pscustomobject]@{ ExitCode = if ($script:AiChildStarts % 2) { 7 } else { 0 } }
                $child | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:AiDisposedCount++; $script:AiLifecycle.Add('dispose') }
                return $child
            }
            Set-TestFunction 'Wait-ApiChild' { param($Child, [int]$Milliseconds); if ($script:AiChildStarts -eq 7) { $script:AiClock = $script:AiClock.AddSeconds(60) }; return $true }
            Set-TestFunction 'Start-Sleep' {
                param([int]$Seconds)
                $script:AiRestartDelays.Add($Seconds); $script:AiLifecycle.Add('sleep')
                if ($script:AiRestartDelays.Count -eq 7) { throw 'End synthetic API supervisor loop.' }
            }
            Assert-Throws { Invoke-ApiSupervisor } 'End synthetic API supervisor loop'
            Assert-True ($script:AiConfigCalls -eq 1 -and $script:AiChildStarts -eq 7 -and $script:AiDisposedCount -eq 7) 'API restart repeated credential setup, missed an exit or leaked a handle.'
            Assert-True (($script:AiRestartDelays -join ',') -ceq '3,6,12,24,30,30,3') 'API restart busy-looped, exceeded its cap or failed to reset after a healthy session.'
            Assert-True (($script:AiLifecycle -join ',') -ceq ((@('start,dispose,sleep') * 7) -join ',')) 'API restart began before disposal or backoff.'
        }
    }
    Invoke-Test 'API supervisor preserves occupied ports and backs off without starting replacement children' {
        foreach ($foreign in @($false, $true)) {
            $script:AiConfigFails = $false; $script:AiConfigCalls = 0; $script:AiChildStarts = 0; $script:AiPortChecks = 0
            $script:AiForeignPort = $foreign
            $script:AiRestartDelays = New-Object 'Collections.Generic.List[int]'
            Set-TestFunction 'Get-OwnedListener' { $script:AiPortChecks++; if ($script:AiForeignPort) { throw 'Port is occupied by another service.' }; return @{ OwningProcess = 72002 } }
            Set-TestFunction 'Start-Sleep' { param([int]$Seconds); $script:AiRestartDelays.Add($Seconds); if ($script:AiRestartDelays.Count -eq 2) { throw 'End synthetic API supervisor loop.' } }
            Assert-Throws { Invoke-ApiSupervisor } 'End synthetic API supervisor loop'
            Assert-True ($script:AiPortChecks -eq 2 -and $script:AiChildStarts -eq 0 -and ($script:AiRestartDelays -join ',') -ceq '3,6') 'API restart ignored occupied port ownership or failed to back off.'
        }
    }
} catch {
    $script:Failures.Add('Test harness: ' + $_.Exception.Message)
    Write-Host ('[FAIL] Test harness: ' + $_.Exception.Message)
} finally {
    try { Restore-TestFunctions } catch { $script:Failures.Add('Function restoration failed: ' + $_.Exception.Message) }
    try {
        if (Test-Path -LiteralPath $script:TemporaryRoot) {
            $resolved = (Resolve-Path -LiteralPath $script:TemporaryRoot).ProviderPath
            $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
            if (-not [IO.Path]::IsPathRooted($resolved) -or $resolved -cne $script:TemporaryRoot -or -not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Refusing cleanup outside the exact owned temporary directory.'
            }
            if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of a linked temporary directory.' }
            if (@(Get-ChildItem -LiteralPath $resolved -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) {
                throw 'Refusing cleanup of a temporary directory containing links.'
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    } catch { $script:Failures.Add('Temporary cleanup failed: ' + $_.Exception.Message) }
}

Write-Host ('RESULT: ' + $script:Passed + ' PASS, ' + $script:Failures.Count + ' FAIL')
if ($script:Failures.Count -gt 0) {
    foreach ($failure in $script:Failures) { Write-Host ('FAILURE: ' + $failure) }
    exit 1
}
exit 0
