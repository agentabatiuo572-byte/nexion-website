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
        Assert-True ($BaseUri -ceq 'http://127.0.0.1:8787' -and $Path -ceq '/api/publish/runner-state' -and $Method -ceq 'GET') 'Runner readiness used an unexpected API route.'
        Assert-True (-not $Cookie -and $BearerToken -ceq $script:ExpectedPublishToken -and $null -eq $Body) 'Runner readiness borrowed a password/session or lost its independent bearer.'
        return @{ Status = $script:RunnerApiStatus; Json = @{ environment = 'dev'; executor = @{ mode = 'local'; ready = $true } } }
    }
    $script:ExpectedPublishToken = New-LocalPassword
    $script:RunnerApiStatus = 200
    Invoke-Test 'Publish readiness authenticates only with its dedicated bearer' {
        Assert-True (Get-PublishRunnerState $script:ExpectedPublishToken).executor.ready 'Dedicated runner readiness failed.'
        $script:RunnerApiStatus = 401
        Assert-Throws { Get-PublishRunnerState $script:ExpectedPublishToken } 'not loaded'
        $script:RunnerApiStatus = 200
    }
    Set-TestFunction 'Stop-OwnedApi' { $script:ReloadEvents.Add('stop-owned'); $script:RunnerApiStatus = 200 }
    Set-TestFunction 'Ensure-LocalService' { param([string]$Name); $script:ReloadEvents.Add('start-' + $Name) }
    $script:ReloadEvents = New-Object 'Collections.Generic.List[string]'
    Invoke-Test 'An old running API is reloaded before runner startup and then reused' {
        $script:RunnerApiStatus = 401
        Ensure-PublishApi $script:ExpectedPublishToken
        Ensure-PublishApi $script:ExpectedPublishToken
        Assert-True (($script:ReloadEvents -join ',') -ceq 'stop-owned,start-api') 'API reload was skipped or repeated after authenticated readiness succeeded.'
    }
    Invoke-Test 'API ownership failure aborts reload before launching a replacement' {
        $script:ReloadEvents.Clear()
        $script:RunnerApiStatus = 401
        Set-TestFunction 'Stop-OwnedApi' { throw 'Unowned service must remain running.' }
        Assert-Throws { Ensure-PublishApi $script:ExpectedPublishToken } 'Unowned service'
        Assert-True ($script:ReloadEvents.Count -eq 0) 'Replacement API started despite rejected ownership.'
        $script:RunnerApiStatus = 200
    }
    Invoke-Test 'Runner receives the dedicated secret but no administrator password or cookie' {
        $names = @('PUBLISH_RUNNER_TOKEN', 'PUBLISH_API_URL', 'PUBLISH_COOKIE', 'COOKIE', 'ADMIN_PASSWORD', 'PUBLISH_PASSWORD', 'SETUP_TOKEN')
        $previous = @{}
        foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, 'synthetic-inherited-value', 'Process') }
        Set-TestFunction 'Invoke-Npm' {
            param([string]$Directory, [string[]]$Arguments)
            Assert-True ($Directory -ieq (Join-Path $RepoRoot 'worker') -and ($Arguments -join ' ') -ceq 'run publish:runner') 'Runner command contains unexpected arguments.'
            Assert-True ($env:PUBLISH_RUNNER_TOKEN -ceq (Read-LocalPassword (Join-Path $LocalDir 'publish-runner-token.dpapi')) -and $env:PUBLISH_API_URL -ceq 'http://127.0.0.1:8787') 'Runner did not receive its own dedicated configuration.'
            foreach ($name in @('PUBLISH_COOKIE', 'COOKIE', 'ADMIN_PASSWORD', 'PUBLISH_PASSWORD', 'SETUP_TOKEN')) { Assert-True (-not [Environment]::GetEnvironmentVariable($name, 'Process')) 'Administrator credentials leaked to the runner environment.' }
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
    Invoke-Test 'One-click startup initializes the account and automatically starts publishing' {
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
        Set-TestFunction 'Initialize-PublishConfiguration' { $script:StartupEvents.Add('publish-config'); return @{ Token = 'synthetic-dedicated-publish-token-for-startup' } }
        Set-TestFunction 'Ensure-LocalService' { param([string]$Name); $script:StartupEvents.Add($Name) }
        Set-TestFunction 'Ensure-PublishApi' { $script:StartupEvents.Add('api-authenticated') }
        Set-TestFunction 'Initialize-LocalAdmin' { $script:StartupEvents.Add('admin-login'); return @{ Created = $false; Password = 'synthetic-admin' } }
        Set-TestFunction 'Ensure-PublishRunner' { $script:StartupEvents.Add('runner-ready') }
        Start-Website
        Assert-True (($script:StartupEvents -join ',') -ceq 'publish-config,api,api-authenticated,site,admin,admin-login,runner-ready') 'One-click startup omitted publish setup, API authentication, account verification, or the runner.'
        # Missing schema dependencies must install in that package using its lock.
        Remove-Item -LiteralPath (Join-Path $fixture.Root 'schema/node_modules/zod/package.json')
        $script:SchemaInstalls = 0
        Set-TestFunction 'Invoke-Npm' {
            param([string]$Directory, [string[]]$Arguments)
            Assert-True ($Directory -ceq (Join-Path $script:RepoRoot 'schema') -and ($Arguments -join ' ') -ceq 'ci --no-audit --no-fund') 'Missing schema invoked an unexpected package or command.'
            $script:SchemaInstalls++
        }
        Start-Website
        Assert-True ($script:SchemaInstalls -eq 1) 'Missing schema dependencies were not installed.'
    }
    $script:RepoRoot = $script:RealRepoRoot
    $script:LocalDir = $script:RealLocalDir
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
