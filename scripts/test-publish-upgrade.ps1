#Requires -Version 5.1
# This suite imports only helper definitions and substitutes every service/API action.
# It never starts/stops a real process, reads credentials, or writes a database.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-publish.ps1')
$script:Passed = 0

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Text) {
    try { & $Action; throw 'Expected rejection was missing.' }
    catch { if ($_.Exception.Message -notlike ('*' + $Text + '*')) { throw } }
}
function Invoke-Test([string]$Name, [scriptblock]$Action) {
    & $Action
    $script:Passed++
    Write-Host ('PASS: ' + $Name)
}
function New-State([bool]$Ready, [bool]$Safe, $Active = $null) {
    return [pscustomobject]@{
        protocol = 1; environment = 'dev'; mode = 'local'; storageReady = $Ready
        restartSafe = $Safe; requiredMigration = '0021_publish_checks.sql'; activeVersion = $Active
    }
}
function Reset-Fixture([object[]]$States) {
    $script:Responses = New-Object 'Collections.Generic.Queue[object]'
    foreach ($state in $States) { $script:Responses.Enqueue($state) }
    $script:Stops = 0; $script:Starts = 0; $script:RunnerChecks = 0
    $script:Owned = $true; $script:HttpStatus = 200
}
function Get-ServiceDefinition([string]$Name) { return @{ Name = $Name } }
function Get-OwnedListener($Definition) { return @(1) }
function Get-VerifiedApiSupervisor { if ($script:Owned) { return [pscustomobject]@{ ProcessId = 123 } }; return $null }
function Invoke-LocalApi([string]$BaseUri, [string]$Path, [string]$Method, $Body, [string]$Cookie, [string]$Token) {
    Assert-True ($BaseUri -ceq 'http://127.0.0.1:8787') 'Unexpected origin.'
    Assert-True ($Method -ceq 'GET' -and $null -eq $Body -and -not $Cookie) 'Readiness was not a read-only machine probe.'
    Assert-True ($Token -ceq 'synthetic-test-token') 'Unexpected credential.'
    if ($Path -ceq '/api/publish/runner-state?readiness=1') {
        if ($script:Responses.Count -eq 0) { throw 'Unexpected extra readiness request.' }
        return [pscustomobject]@{ Status = $script:HttpStatus; Json = $script:Responses.Dequeue() }
    }
    Assert-True ($Path -ceq '/api/publish/runner-state') 'Unexpected API path.'
    $script:RunnerChecks++
    return [pscustomobject]@{ Status = 200; Json = [pscustomobject]@{ environment = 'dev'; executor = @{ mode = 'local'; ready = $false } } }
}
function Stop-OwnedApi { $script:Stops++ }
function Ensure-LocalService([string]$Name) { Assert-True ($Name -ceq 'api') 'Wrong service restarted.'; $script:Starts++ }

Invoke-Test 'Healthy API is reused without restarting or requiring runner heartbeat yet' {
    Reset-Fixture @((New-State $true $false))
    Ensure-PublishApi 'synthetic-test-token'
    Assert-True ($script:Stops -eq 0 -and $script:Starts -eq 0 -and $script:RunnerChecks -eq 1) 'Healthy reuse failed.'
}
Invoke-Test 'Idle missing schema is rechecked, restarted once and verified afterward' {
    Reset-Fixture @((New-State $false $true), (New-State $false $true), (New-State $true $false))
    Ensure-PublishApi 'synthetic-test-token'
    Assert-True ($script:Stops -eq 1 -and $script:Starts -eq 1 -and $script:Responses.Count -eq 0) 'Upgrade sequence was incomplete.'
}
Invoke-Test 'Active or uncertain publication is never killed for an upgrade' {
    Reset-Fixture @((New-State $false $false 42))
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'awaiting verification'
    Assert-True ($script:Stops -eq 0) 'Active API was stopped.'
}
Invoke-Test 'A new blocker found in the second check prevents restart' {
    Reset-Fixture @((New-State $false $true), (New-State $false $false 42))
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'safety changed'
    Assert-True ($script:Stops -eq 0) 'Changed safety was ignored.'
}
Invoke-Test 'Concurrent completed upgrade is reused instead of restarted' {
    Reset-Fixture @((New-State $false $true), (New-State $true $false))
    Ensure-PublishApi 'synthetic-test-token'
    Assert-True ($script:Stops -eq 0 -and $script:RunnerChecks -eq 1) 'Already completed migration caused restart.'
}
Invoke-Test 'Incomplete migration after restart is not retried in a loop' {
    Reset-Fixture @((New-State $false $true), (New-State $false $true), (New-State $false $true))
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'did not complete'
    Assert-True ($script:Stops -eq 1 -and $script:Starts -eq 1 -and $script:RunnerChecks -eq 0) 'Upgrade loop or false success.'
}
Invoke-Test 'Old API returning HTTP 200 without capabilities is not trusted' {
    Reset-Fixture @([pscustomobject]@{ environment = 'dev'; executor = @{ mode = 'local' } })
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'does not support'
    Assert-True ($script:Stops -eq 0) 'Unproven old API was stopped.'
}
Invoke-Test 'Authentication failure does not authorize a restart' {
    Reset-Fixture @((New-State $false $true)); $script:HttpStatus = 401
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'HTTP 401'
    Assert-True ($script:Stops -eq 0) 'Auth failure authorized a stop.'
}
Invoke-Test 'Foreign process ownership prevents sending a credential' {
    Reset-Fixture @((New-State $false $true)); $script:Owned = $false
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'ownership'
    Assert-True ($script:Stops -eq 0 -and $script:Responses.Count -eq 1) 'Credential sent before ownership proof.'
}
Invoke-Test 'Missing global job state is not interpreted as idle' {
    $state = New-State $false $true
    $state.PSObject.Properties.Remove('activeVersion')
    Reset-Fixture @($state)
    Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'incomplete'
    Assert-True ($script:Stops -eq 0) 'Incomplete state authorized restart.'
}
Invoke-Test 'Production and malformed readiness values are rejected' {
    foreach ($field in @('environment', 'storageReady', 'restartSafe', 'protocol', 'requiredMigration')) {
        $state = New-State $false $true
        $state.$field = 'invalid'
        Reset-Fixture @($state)
        Assert-Throws { Ensure-PublishApi 'synthetic-test-token' } 'does not support'
        Assert-True ($script:Stops -eq 0) 'Malformed readiness authorized restart.'
    }
}
Write-Host ('Passed ' + $script:Passed + ' publish upgrade regression cases.')
