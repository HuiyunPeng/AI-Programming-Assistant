@echo off

:: Get the current script's directory
SET SCRIPT_DIR=%~dp0
SET PYTHON3=python
SET RUNPY=%SCRIPT_DIR%src\run.py
SET IMGSUM=%SCRIPT_DIR%src\img-summary.py
SET LEAP_PROMPT=%SCRIPT_DIR%src\implement_it.txt
SET OPENAI_API_KEY=OPENAI_API_KEY
SET OPENAI_BASE_URL=OPENAI_BASE_URL

echo %SCRIPT_DIR%
echo %RUNPY%

:: Execute the original script with the set environment variables
SET PYTHON3=%PYTHON3%
SET RUNPY=%RUNPY%
SET IMGSUM=%IMGSUM%
SET LEAP_PROMPT=%LEAP_PROMPT%
SET OPENAI_API_KEY=%OPENAI_API_KEY%
SET OPENAI_BASE_URL=%OPENAI_BASE_URL%
.\scripts\code.bat
