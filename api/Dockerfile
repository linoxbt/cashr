FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml requirements.lock ./
# Exact versions with hashes (uv pip compile pyproject.toml --generate-hashes -o requirements.lock).
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY cashr ./cashr
RUN pip install --no-cache-dir --no-deps .
RUN useradd --create-home cashr && mkdir -p /data && chown cashr /data
USER cashr
ENV CASHR_DATABASE_URL=sqlite:////data/cashr.db
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)" || exit 1
# --no-access-log: the API must never record visitor IP addresses.
CMD ["uvicorn", "cashr.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
