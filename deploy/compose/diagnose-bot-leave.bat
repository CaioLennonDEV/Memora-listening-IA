@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo === Runtime env ===
docker compose exec -T runtime printenv BOT_ROSTER_ALONE_DEBOUNCE_MS
docker compose exec -T runtime printenv HOST_BOT_DIST_OVERLAY
docker compose exec -T runtime printenv HOST_BOT_BROWSER_UTILS
echo.

echo === Bot containers (running) ===
docker ps --filter "name=vexa-mtg" --format "{{.ID}}  {{.Names}}  {{.Status}}"
echo.

set "CID="
rem CMD treats = as a token break inside for /f `...` — quote the filter.
for /f "usebackq delims=" %%i in (`docker ps -q --filter "name=vexa-mtg"`) do (
  if not defined CID set "CID=%%i"
)

if not defined CID (
  echo NENHUM bot rodando. Mande o bot no Terminal e rode este .bat de novo.
  exit /b 2
)

echo Usando CID=!CID!
echo.

echo === Mounts do bot ===
docker inspect !CID! --format "{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}"
echo.

echo === Env no bot ===
docker exec !CID! printenv BOT_ROSTER_ALONE_DEBOUNCE_MS
echo.

echo === Codigo do leave no bot (precisa achar alonePending / armed) ===
docker exec !CID! grep -n "alonePending\|armed leave\|leaving after" /app/core/meetings/services/bot/dist/roster.js
echo.

echo === Logs relevantes ===
docker logs !CID! 2>&1 | findstr /i "roster alone debounce armed leaving left_alone aloneness"
echo.
echo === Fim ===
exit /b 0
