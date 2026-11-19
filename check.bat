@echo off
call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set CARGO_BUILD_JOBS=1
cd /d "%~dp0src-tauri"
cargo build --release
