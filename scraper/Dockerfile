# RecruiterOS · LinkedIn scraper sidecar
# Playwright's official Python image ships chromium + all OS deps, so we don't
# fight apt for browser libraries. Pinned to match playwright==1.47 in requirements.
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

# Install Python deps first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The base image bundles the browsers, but install chromium explicitly so a
# version bump in requirements stays self-consistent.
RUN python -m playwright install chromium

COPY app.py engine.py ./

EXPOSE 8000
# Single worker on purpose: the engine holds ONE browser and serializes scrapes.
# Scaling out means more browsers/sessions, which is exactly what gets accounts
# flagged — so we keep it to one.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
