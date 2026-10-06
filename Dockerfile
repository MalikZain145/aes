# Abasyn Scheduler — single image: Node (Express API + built React UI) + Python
# (OR-Tools / pandas / scipy scheduling engines). Designed for Render's free Docker
# web service. Render provides $PORT at runtime.

FROM node:20-bookworm-slim

# ── System Python (for the scheduler engines) ──────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Isolated venv so pip installs cleanly on Debian (PEP 668) and PYTHON_BIN is stable.
ENV VENV=/opt/venv
RUN python3 -m venv "$VENV"
ENV PATH="$VENV/bin:$PATH"
ENV PYTHON_BIN="/opt/venv/bin/python3"

WORKDIR /app

# ── Python deps (cached layer) ─────────────────────────────────────────────────
COPY scheduler/requirements.txt ./scheduler/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r scheduler/requirements.txt

# ── Backend deps (cached layer) ────────────────────────────────────────────────
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# ── Frontend deps + production build (cached layer) ────────────────────────────
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

# ── App source ─────────────────────────────────────────────────────────────────
COPY backend ./backend
COPY scheduler ./scheduler

ENV NODE_ENV=production

# Run as a non-root user (Hugging Face Spaces runs containers as uid 1000; it must
# own the app dir so the scheduler can write PDFs to scheduler/output and the admit
# HMAC secret to backend/). Harmless on Render/Koyeb too.
RUN mkdir -p /app/scheduler/output \
 && useradd -m -u 1000 appuser \
 && chown -R 1000:1000 /app
USER 1000

# Render injects $PORT; Hugging Face routes to app_port (README metadata). The
# server falls back to 5000, which both platforms are pointed at.
EXPOSE 5000
CMD ["node", "backend/server.js"]
