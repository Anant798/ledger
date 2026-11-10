$ErrorActionPreference = 'Stop'

# Keep local migration runs independent of any credentials a developer may use
# for hosted Supabase projects in their shell session.
$hadDbPassword = Test-Path Env:SUPABASE_DB_PASSWORD
$oldDbPassword = $env:SUPABASE_DB_PASSWORD
$hadAccessToken = Test-Path Env:SUPABASE_ACCESS_TOKEN
$oldAccessToken = $env:SUPABASE_ACCESS_TOKEN

try {
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
  & (Join-Path $PSScriptRoot '..\node_modules\.bin\supabase.cmd') db reset
  exit $LASTEXITCODE
}
finally {
  if ($hadDbPassword) { $env:SUPABASE_DB_PASSWORD = $oldDbPassword }
  if ($hadAccessToken) { $env:SUPABASE_ACCESS_TOKEN = $oldAccessToken }
}
