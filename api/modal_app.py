"""Optional deployment on Modal: `modal deploy modal_app.py`.

Unlisted's scanner must run continuously and the API must be the only writer
to its database, so this pins exactly one always-warm container. The wallet
(Zallet or zcashd) runs elsewhere and is reached over UNLISTED_RPC_URL.
Use a Postgres UNLISTED_DATABASE_URL in production; see docs/DEPLOY.md.
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi>=0.115", "uvicorn[standard]>=0.30", "sqlalchemy>=2.0", "httpx>=0.27",
                 "psycopg[binary]>=3.2")
    .add_local_python_source("unlisted")
)
volume = modal.Volume.from_name("unlisted-data", create_if_missing=True)
app = modal.App("unlisted-api")


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("unlisted")],
    min_containers=1,
    max_containers=1,
    timeout=24 * 60 * 60,
)
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def api():
    import os

    os.environ.setdefault("UNLISTED_DATABASE_URL", "sqlite:////data/unlisted.db")
    from unlisted.app import create_app

    return create_app()
