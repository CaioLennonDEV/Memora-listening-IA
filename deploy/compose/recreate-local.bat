@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem =============================================================================
rem recreate-local.bat — zera o stack compose local, sobe de novo, rebuilda o
rem overlay de roster/leave e recria o runtime.
rem
rem Uso:
rem   recreate-local.bat           → down -v (apaga volumes: postgres/redis/etc.)
rem   recreate-local.bat --keep    → down sem -v (mantém dados locais)
rem
rem Requer: Docker Desktop rodando, .env já configurado nesta pasta.
rem =============================================================================

set "KEEP_VOLUMES=0"
if /i "%~1"=="--keep" set "KEEP_VOLUMES=1"
if /i "%~1"=="/keep" set "KEEP_VOLUMES=1"

echo.
echo === [1/6] Derrubar stack compose ===
if "%KEEP_VOLUMES%"=="1" (
  echo     modo: manter volumes (--keep)
  docker compose down --remove-orphans
) else (
  echo     modo: apagar volumes (-v^) — Postgres/Redis/workspaces locais zerados
  docker compose down -v --remove-orphans
)
if errorlevel 1 (
  echo ERRO: docker compose down falhou
  exit /b 1
)

echo.
echo === [2/6] Remover containers de bot orfaos (vexa-mtg*) ===
for /f "usebackq delims=" %%i in (`docker ps -aq --filter name=vexa-mtg 2^>nul`) do (
  echo     removendo %%i
  docker rm -f %%i >nul
)

echo.
echo === [3/6] Pull imagens ===
docker compose pull
if errorlevel 1 (
  echo ERRO: docker compose pull falhou
  exit /b 1
)

echo.
echo === [4/6] Subir stack ===
docker compose up -d --no-build
if errorlevel 1 (
  echo ERRO: docker compose up falhou
  exit /b 1
)

echo.
echo === [5/6] Rebuild overlay roster/leave ===
call "%~dp0patches\build-roster-overlay.cmd"
if errorlevel 1 (
  echo ERRO: build-roster-overlay.cmd falhou
  exit /b 1
)

echo.
echo === [6/6] Recriar runtime (aplica HOST_BOT_* + BOT_ROSTER_*) ===
docker compose up -d --no-build --force-recreate runtime
if errorlevel 1 (
  echo ERRO: force-recreate runtime falhou
  exit /b 1
)

echo.
echo === Conferencia de env no runtime ===
echo BOT_ROSTER_ALONE_DEBOUNCE_MS=
docker compose exec -T runtime printenv BOT_ROSTER_ALONE_DEBOUNCE_MS
echo HOST_BOT_DIST_OVERLAY=
docker compose exec -T runtime printenv HOST_BOT_DIST_OVERLAY
echo HOST_BOT_BROWSER_UTILS=
docker compose exec -T runtime printenv HOST_BOT_BROWSER_UTILS

echo.
echo =============================================================================
echo  Pronto.
echo    Terminal : http://localhost:13000
echo    1^) Abra o Terminal e mande o bot
echo    2^) docker ps --format "{{.ID}} {{.Names}} {{.Status}}"
echo    3^) Com 0 in the room, espere ~60s — o bot deve sair
echo.
echo  Se usou down -v (padrao^), login/API key podem precisar ser gerados de novo.
echo =============================================================================
exit /b 0
