"""ASGI entrypoint: ``uvicorn cashr.main:app --no-access-log``."""

from .app import create_app

app = create_app()
