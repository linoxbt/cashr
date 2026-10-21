"""ASGI entrypoint: ``uvicorn unlisted.main:app --no-access-log``."""

from .app import create_app

app = create_app()
