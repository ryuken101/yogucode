# One image: the built website and the API, served together by app.server:site.
# (Ken's decision, 10 Oct 2026: one app on Fly.io, one address — see apps/api/src/app/server.py.)
#
# Built by Fly's remote builder (`fly deploy`); this machine has no Docker.

# --- the website ------------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /repo/apps/web

# The two public Supabase values the browser needs for teacher sign-in. Public by design
# (the anon key is meant to be shipped to browsers); passed from fly.toml [build.args].
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_BASE_URL=/api

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
# `prebuild` copies Pyodide out of node_modules into public/pyodide, so it ships with us.
RUN npm run build

# --- the API ------------------------------------------------------------------------------
FROM python:3.12-slim AS api
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    WEB_DIST=/srv/web
WORKDIR /srv/api

COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api/ ./
RUN uv sync --frozen --no-dev

COPY --from=web /repo/apps/web/dist /srv/web

EXPOSE 8080
# One worker, on purpose: the live classroom's hub and the quiz timers live in this
# process's memory (app/live/hub.py, app/quiz.py). A second worker would split a class.
CMD ["/srv/api/.venv/bin/uvicorn", "app.server:site", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
