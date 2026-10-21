FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml ./
COPY unlisted ./unlisted
RUN pip install --no-cache-dir ".[postgres]"
RUN useradd --create-home unlisted && mkdir -p /data && chown unlisted /data
USER unlisted
ENV UNLISTED_DATABASE_URL=sqlite:////data/unlisted.db
EXPOSE 8000
# --no-access-log: the API must never record visitor IP addresses.
CMD ["uvicorn", "unlisted.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
