@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  ==========================================
echo   InfraCore GEO  --  Packaging Script
echo  ==========================================
echo.

REM ── Version ───────────────────────────────────────────────────────────────────
set /p "VERSION=Version (z.B. 1.2.0): "
if "!VERSION!"=="" ( echo  FEHLER: Keine Version angegeben. & pause & exit /b 1 )

REM ── Passwort (Eingabe versteckt, gespeichert ohne BOM) ────────────────────────
powershell -NoProfile -Command "$p=Read-Host 'Passwort' -AsSecureString; $pw=[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)); [IO.File]::WriteAllText('%TEMP%\_icpw.tmp',$pw,[Text.Encoding]::ASCII)"
set /p "PASSWORD=" < "%TEMP%\_icpw.tmp"
if "!PASSWORD!"=="" ( del /q "%TEMP%\_icpw.tmp" 2>nul & echo  FEHLER: Kein Passwort angegeben. & pause & exit /b 1 )

REM ── 7-Zip suchen ──────────────────────────────────────────────────────────────
set "SZ="
where 7z >nul 2>&1
if not errorlevel 1 set "SZ=7z"
if "!SZ!"=="" if exist "C:\Program Files\7-Zip\7z.exe"       set "SZ=C:\Program Files\7-Zip\7z.exe"
if "!SZ!"=="" if exist "C:\Program Files (x86)\7-Zip\7z.exe" set "SZ=C:\Program Files (x86)\7-Zip\7z.exe"
if "!SZ!"=="" (
    del /q "%TEMP%\_icpw.tmp" 2>nul
    echo  FEHLER: 7-Zip nicht gefunden. Bitte installieren: https://www.7-zip.org
    pause & exit /b 1
)
echo  7-Zip: !SZ!

REM ── Pfade ─────────────────────────────────────────────────────────────────────
set "FOLDER=infracore-geo-v!VERSION!"
set "STAGING=%~dp0.pack-staging"
set "STAGE_DIR=!STAGING!\!FOLDER!"
set "RELEASES=%~dp0releases"
set "ZIP=!RELEASES!\!FOLDER!.7z"

REM ── package.json versionieren ─────────────────────────────────────────────────
powershell -NoProfile -Command "$f='%~dp0package.json'; $c=[IO.File]::ReadAllText($f); $c=$c -replace '\"version\":\s*\"[^\"]*\"','\"version\": \"!VERSION!\"'; [IO.File]::WriteAllText($f,$c,[Text.Encoding]::UTF8)"
echo  Version:  !VERSION! (package.json aktualisiert)

REM ── Staging vorbereiten ───────────────────────────────────────────────────────
if exist "!STAGING!" rmdir /s /q "!STAGING!"
mkdir "!STAGE_DIR!"
if not exist "!RELEASES!" mkdir "!RELEASES!"

REM ── Dateien kopieren ──────────────────────────────────────────────────────────
echo.
echo  Kopiere Dateien:

xcopy /Y "%~dp0index.html"        "!STAGE_DIR!\" >nul
echo    + index.html
xcopy /Y "%~dp0server.js"         "!STAGE_DIR!\" >nul
echo    + server.js
xcopy /Y "%~dp0package.json"      "!STAGE_DIR!\" >nul
echo    + package.json
if exist "%~dp0package-lock.json" xcopy /Y "%~dp0package-lock.json" "!STAGE_DIR!\" >nul & echo    + package-lock.json
if exist "%~dp0start-app.bat"     xcopy /Y "%~dp0start-app.bat"     "!STAGE_DIR!\" >nul & echo    + start-app.bat

robocopy "%~dp0src"    "!STAGE_DIR!\src"    /E /NFL /NDL /NJH /NJS >nul
echo    + src\
robocopy "%~dp0server" "!STAGE_DIR!\server" /E /NFL /NDL /NJH /NJS >nul
echo    + server\
if exist "%~dp0ifc example" (
    robocopy "%~dp0ifc example" "!STAGE_DIR!\ifc example" /E /NFL /NDL /NJH /NJS >nul
    echo    + ifc example\
)
echo !VERSION!> "!STAGE_DIR!\VERSION"
echo    + VERSION

REM ── 7-Zip über PowerShell-Script aufrufen (umgeht CMD-Escaping für Passwort) ──
if exist "!ZIP!" del /q "!ZIP!"
echo.
echo  Erstelle Archiv...

(
  echo $sz  = '!SZ!'
  echo $pw  = [IO.File]::ReadAllText^('%TEMP%\_icpw.tmp'^, [Text.Encoding]::ASCII^)
  echo $zip = '!ZIP!'
  echo Push-Location '!STAGING!'
  echo ^& $sz a '-t7z' '-mhe=on' "-p$pw" $zip '!FOLDER!'
  echo $ec  = $LASTEXITCODE
  echo Pop-Location
  echo exit $ec
) > "%TEMP%\_icpack.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\_icpack.ps1"
set "ZIP_ERR=!errorlevel!"

del /q "%TEMP%\_icpack.ps1" 2>nul
del /q "%TEMP%\_icpw.tmp"   2>nul
rmdir /s /q "!STAGING!"

if !ZIP_ERR! neq 0 (
    echo  FEHLER beim Packen ^(Code !ZIP_ERR!^).
    pause & exit /b 1
)

echo.
echo  ==========================================
echo   Fertig!
echo   Datei:    releases\!FOLDER!.7z
echo   Version:  !VERSION!
echo  ==========================================
echo.
echo  Entpacken: 7-Zip Rechtsklick -^> Extrahieren -^> Passwort eingeben
echo  Danach:    npm install  ^&^&  npm start
echo.
pause
