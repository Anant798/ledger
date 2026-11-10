param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('version', 'start', 'status', 'stop', 'reset', 'migration-list', 'types')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$dockerCli = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'
if (Test-Path (Join-Path $dockerCli 'docker.exe')) {
  $env:PATH = "$dockerCli;$env:PATH"
}

$cli = Join-Path $PSScriptRoot '..\node_modules\.bin\supabase.cmd'
if (-not (Test-Path $cli)) { throw 'Install project dependencies first (npm ci).' }

switch ($Action) {
  'version' { & $cli --version }
  'start' { & $cli start }
  'status' { & $cli status }
  'stop' { & $cli stop }
  'migration-list' { & $cli migration list }
  'reset' {
    # This action is deliberately local-only. Do not add --remote or forward
    # arbitrary CLI arguments from an npm script.
    $hadDbPassword = Test-Path Env:SUPABASE_DB_PASSWORD
    $oldDbPassword = $env:SUPABASE_DB_PASSWORD
    $hadAccessToken = Test-Path Env:SUPABASE_ACCESS_TOKEN
    $oldAccessToken = $env:SUPABASE_ACCESS_TOKEN
    try {
      Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
      Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
      & $cli db reset
    }
    finally {
      if ($hadDbPassword) { $env:SUPABASE_DB_PASSWORD = $oldDbPassword }
      if ($hadAccessToken) { $env:SUPABASE_ACCESS_TOKEN = $oldAccessToken }
    }
  }
  'types' {
    $types = & $cli gen types typescript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $types | Set-Content -Path (Join-Path $PSScriptRoot '..\lib\supabase\database.types.ts') -Encoding UTF8
  }
}

exit $LASTEXITCODE
