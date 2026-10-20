param(
  [Parameter(Mandatory)][ValidateSet('prerequisite', 'proof')][string]$Mode,
  [Parameter(Mandatory)][ValidateSet('baseline', 'fixed')][string]$Phase,
  [Parameter(Mandatory)][string]$OutputDir,
  [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
function Assert-Proof([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
Assert-Proof ($IsWindows -and $env:GITHUB_ACTIONS -eq 'true') 'This proof requires a stock Windows Actions runner.'
Assert-Proof ([IO.Path]::IsPathFullyQualified($OutputDir)) 'OutputDir must be absolute.'
$null = New-Item -ItemType Directory -Force -Path $OutputDir
$scratch = Join-Path $env:RUNNER_TEMP ('openclaw-launcher-proof-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$created = [Collections.Generic.List[string]]::new()
$createdProfiles = [Collections.Generic.List[string]]::new()
$canary = 'SYNTHETIC_LAUNCHER_SECRET_' + [Guid]::NewGuid().ToString('N')
$receipt = [ordered]@{ mode = $Mode; phase = $Phase; complete = $false; taskCleanup = $false; cases = @() }

function Save-Json([string]$Name, $Value) {
  $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $OutputDir $Name) -Encoding utf8
}
function Get-TextHash([string]$Value) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value)))
}
function Find-Task([string]$Name) {
  @($folder.GetTasks(0) | Where-Object { $_.Name -ceq $Name })
}
function New-ProofTask([string]$Launcher, [string]$WorkingDirectory, [string]$TaskName = '') {
  $name = if ($TaskName) { $TaskName } else { 'OpenClaw-Launcher-Proof-' + [Guid]::NewGuid().ToString('N') }
  Assert-Proof ((Find-Task $name).Count -eq 0) 'Unique proof task already exists.'
  $definition = $scheduler.NewTask(0)
  $definition.RegistrationInfo.Description = 'Isolated OpenClaw inspection proof; never run.'
  $definition.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.AllowDemandStart = $false
  $definition.Settings.StartWhenAvailable = $false
  $definition.Settings.ExecutionTimeLimit = 'PT1M'
  $trigger = $definition.Triggers.Create(1)
  $trigger.StartBoundary = (Get-Date).AddDays(7).ToString('s')
  $trigger.Enabled = $true
  $action = $definition.Actions.Create(0)
  $action.Path = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $action.Arguments = '/d /s /c ""' + $Launcher + '""'
  $action.WorkingDirectory = $WorkingDirectory
  $created.Add($name)
  $null = $folder.RegisterTaskDefinition($name, $definition, 2, $definition.Principal.UserId, $null, 3, $null)
  Assert-Proof ((Find-Task $name).Count -eq 1) 'Native task registration was not observable.'
  return $name
}
function Get-TaskSnapshot([string]$Name, [string]$Launcher) {
  $task = $folder.GetTask($Name)
  Assert-Proof ($task.State -eq 1 -or $task.State -eq 3) 'Proof task is queued, running, or unknown.'
  [ordered]@{
    xmlHash = Get-TextHash $task.Xml
    launcherHash = (Get-FileHash -LiteralPath $Launcher -Algorithm SHA256).Hash
    lastRunTime = $task.LastRunTime.ToString('o')
    lastRunResult = $task.LastTaskResult
    state = $task.State
  }
}
function Assert-Unchanged($Before, $After) {
  foreach ($field in @('xmlHash', 'launcherHash', 'lastRunTime', 'lastRunResult', 'state')) {
    Assert-Proof ($Before[$field] -ceq $After[$field]) "Inspection changed proof task field $field."
  }
}
function Invoke-ProofCli([string]$Case, [string]$Command, [hashtable]$Environment) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $start.WorkingDirectory = $SourceRoot
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment.Clear()
  foreach ($key in @('PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)',
      'ProgramW6432', 'PNPM_HOME', 'COREPACK_HOME', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'PROCESSOR_ARCHITECTURE')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($null -ne $value) { $start.Environment[$key] = $value }
  }
  foreach ($key in $Environment.Keys) { $start.Environment[$key] = $Environment[$key] }
  $pnpm = (Get-Command pnpm.cmd -CommandType Application | Select-Object -First 1).Source
  Assert-Proof (Test-Path -LiteralPath $pnpm -PathType Leaf) 'A single pnpm application must be selected.'
  # cmd.exe owns quoting here; ArgumentList would apply C-runtime quote escaping.
  $start.Arguments = '/d /s /c ""' + $pnpm + '" --silent openclaw --profile ' + $Environment.OPENCLAW_PROFILE + ' ' + $Command + '"'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $started = $false
  try {
    Assert-Proof ($process.Start()) 'CLI child did not start.'
    $started = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $finished = $process.WaitForExit(600000)
    if (-not $finished) {
      $process.Kill($true)
      $process.WaitForExit()
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $label = if ($Command.StartsWith('gateway')) { 'status' } else { 'update' }
    # Fail on leakage, but still redact synthetic sensitive input at artifact egress.
    $stdout.Replace($canary, '[REDACTED]') | Set-Content -LiteralPath (Join-Path $OutputDir "$Case-$label.stdout.txt") -Encoding utf8
    $stderr.Replace($canary, '[REDACTED]') | Set-Content -LiteralPath (Join-Path $OutputDir "$Case-$label.stderr.txt") -Encoding utf8
    Assert-Proof $finished 'CLI proof exceeded its ten-minute deadline; partial output was retained.'
    Assert-Proof (-not ($stdout + $stderr).Contains($canary)) 'CLI leaked the synthetic launcher secret.'
    Assert-Proof (-not ($stdout + $stderr).Contains('OPENCLAW_GATEWAY_TOKEN=')) 'CLI exposed the rejected assignment.'
    Assert-Proof ($process.ExitCode -eq 0) "CLI $label failed with exit $($process.ExitCode); inspect captured output."
    return ($stdout | ConvertFrom-Json -AsHashtable -Depth 100)
  } finally {
    if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    $process.Dispose()
  }
}

try {
  if ($Mode -eq 'prerequisite') {
    $launcher = Join-Path $scratch 'inert.cmd'
    "@echo off`r`nexit /b 0`r`n" | Set-Content -LiteralPath $launcher -Encoding ascii
    $name = New-ProofTask $launcher $scratch
    $receipt.nativePrerequisite = Get-TaskSnapshot $name $launcher
  } else {
    Assert-Proof ([IO.Path]::IsPathFullyQualified($SourceRoot)) 'SourceRoot must be absolute.'
    $receipt.sourceHead = (& git -C $SourceRoot rev-parse HEAD).Trim()
    Assert-Proof ($LASTEXITCODE -eq 0) 'Could not read exact source head.'
    Assert-Proof (-not (& git -C $SourceRoot status --porcelain --untracked-files=no)) 'Source must be clean before proof.'
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    Assert-Proof (Test-Path -LiteralPath $node -PathType Leaf) 'A single Node application must be selected.'
    $entry = Join-Path $SourceRoot 'dist/entry.js'
    Assert-Proof (Test-Path -LiteralPath $entry -PathType Leaf) 'Canonical CLI build must finish before task registration.'
    $accountHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    Assert-Proof ([IO.Path]::IsPathFullyQualified($accountHome)) 'Native account home must be absolute.'
    foreach ($case in @('invalid', 'literal')) {
      $caseRoot = Join-Path $scratch $case
      foreach ($dir in @($caseRoot, "$caseRoot/appdata", "$caseRoot/localappdata", "$caseRoot/tmp")) {
        $null = New-Item -ItemType Directory -Path $dir
      }
      # Service maintenance requires the real account home and canonical named-profile identity.
      $profile = 'proof-' + [Guid]::NewGuid().ToString('N')
      $profileRoot = Join-Path $accountHome ('.openclaw-' + $profile)
      Assert-Proof (-not (Test-Path -LiteralPath $profileRoot)) 'Unique proof profile already exists.'
      $null = New-Item -ItemType Directory -Path $profileRoot
      $createdProfiles.Add($profileRoot)
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
      $listener.Start()
      $port = $listener.LocalEndpoint.Port
      $listener.Stop()
      $config = Join-Path $profileRoot 'openclaw.json'
      @{ gateway = @{ mode = 'local'; port = $port; auth = @{ mode = 'token'; token = 'synthetic-proof-token' } } } |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $config -Encoding utf8
      $assignment = if ($case -eq 'invalid') { 'set "OPENCLAW_GATEWAY_TOKEN=' + $canary + '%USERPROFILE%"' } else { 'set "OPENCLAW_PROOF_LITERAL=literal-value"' }
      $launcher = Join-Path $profileRoot 'gateway.cmd'
      # Physical line 5 is intentional: comments and a blank line must still count.
      @('@echo off', 'rem physical-line proof', '', ('set "OPENCLAW_PROFILE=' + $profile + '"'), $assignment,
        ('"' + $node + '" "' + $entry + '" gateway --port ' + $port + ' < NUL')) -join "`r`n" |
        Set-Content -LiteralPath $launcher -Encoding ascii -NoNewline
      $name = New-ProofTask $launcher $profileRoot ('OpenClaw Gateway (' + $profile + ')')
      $childEnv = @{
        HOME = $accountHome; USERPROFILE = $accountHome; APPDATA = "$caseRoot/appdata"
        LOCALAPPDATA = "$caseRoot/localappdata"; TEMP = "$caseRoot/tmp"; TMP = "$caseRoot/tmp"
        OPENCLAW_PROFILE = $profile
        COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'; NO_COLOR = '1'
      }
      $before = Get-TaskSnapshot $name $launcher
      $status = Invoke-ProofCli $case 'gateway status --deep --timeout 60000 --json' $childEnv
      Assert-Unchanged $before (Get-TaskSnapshot $name $launcher)
      $update = Invoke-ProofCli $case 'update --dry-run --json' $childEnv
      Assert-Unchanged $before (Get-TaskSnapshot $name $launcher)
      Assert-Proof ($update.dryRun -eq $true) 'Update did not return a dry-run result.'
      Assert-Proof ($null -eq $update.failures -or @($update.failures).Count -eq 0) 'Dry-run reported unrelated preflight failures; this is not product proof.'
      $notes = $update.notes -join "`n"
      $unavailable = 'Gateway service inspection is unavailable; automatic service restart was skipped.'
      $expected = 'Scheduled Task launcher line 5: invalid environment assignment.'
      if ($case -eq 'invalid') {
        Assert-Proof ($null -eq $status.service.command) 'Rejected launcher unexpectedly supplied a command.'
        Assert-Proof ($status.service.runtime.status -eq 'unknown') 'Rejected launcher unexpectedly granted known runtime.'
        Assert-Proof ($notes.Contains($unavailable)) 'Dry-run did not preserve unavailable-service restart refusal.'
        $statusText = $status | ConvertTo-Json -Depth 100
        if ($Phase -eq 'fixed') {
          Assert-Proof ($statusText.Contains($expected) -and $notes.Contains($expected)) 'Safe reason and physical line did not reach both CLI consumers.'
        } else {
          $generic = 'Effective Scheduled Task service command could not be inspected.'
          Assert-Proof ($statusText.Contains($generic)) 'Baseline status did not reproduce the generic diagnostic.'
          Assert-Proof (-not ($statusText + $notes).Contains('Scheduled Task launcher line ')) 'Baseline already supplies the proposed diagnostic.'
        }
      } else {
        Assert-Proof ($null -ne $status.service.command) 'Literal control command was rejected.'
        Assert-Proof (($status.service.command.programArguments[0] -ieq $node) -and
          ($status.cli.runtime.execPath -ieq $node)) 'Literal control must use the single selected CLI Node executable.'
        Assert-Proof ($status.service.runtime.status -eq 'stopped') 'Never-run literal control must be stopped.'
        Assert-Proof (($status.service.command.programArguments -contains 'gateway') -and
          ($status.service.command.programArguments -contains "$port")) 'Literal control lost its actual command arguments.'
        Assert-Proof (-not $notes.Contains($unavailable)) 'Literal control incorrectly refused service inspection.'
      }
      $receipt.cases += [ordered]@{ case = $case; profile = $profile; commandPresent = $null -ne $status.service.command
        runtime = $status.service.runtime.status; dryRun = $update.dryRun; unchanged = $true; snapshot = $before }
    }
    Assert-Proof (-not (& git -C $SourceRoot status --porcelain --untracked-files=no)) 'Proof modified tracked source.'
  }
  $receipt.complete = $true
} catch {
  $receipt.failure = $_.Exception.Message.Replace($canary, '[REDACTED]')
  throw
} finally {
  try {
    foreach ($name in $created) {
      if ((Find-Task $name).Count -eq 0) { continue }
      $task = $folder.GetTask($name)
    Assert-Proof ($task.State -eq 1 -or $task.State -eq 3) 'Refusing to delete a task that is not confirmed stopped.'
      $folder.DeleteTask($name, 0)
      Assert-Proof ((Find-Task $name).Count -eq 0) 'Task cleanup could not be verified.'
    }
    $receipt.taskCleanup = $true
    foreach ($profileRoot in $createdProfiles) {
      $resolvedProfile = [IO.Path]::GetFullPath($profileRoot)
      Assert-Proof (([IO.Path]::GetDirectoryName($resolvedProfile) -ceq $accountHome) -and
        ([IO.Path]::GetFileName($resolvedProfile) -cmatch '^\.openclaw-proof-[0-9a-f]{32}$')) 'Profile cleanup escaped the owned canonical identity.'
      Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
      Assert-Proof (-not (Test-Path -LiteralPath $resolvedProfile)) 'Profile cleanup could not be verified.'
    }
    $receipt.profileCleanup = $true
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    $tempPrefix = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    Assert-Proof ($resolvedScratch.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) 'Scratch cleanup escaped RUNNER_TEMP.'
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    $receipt.scratchCleanup = $true
  } finally {
    Save-Json "$Mode-receipt.json" $receipt
  }
}
