"""Optional deployment on Modal: `modal deploy modal_app.py`.

cashr's scanner must run continuously and the API must be the only writer
to its database, so this pins exactly one always-warm container. The wallet
(Zallet or zcashd) runs elsewhere and is reached over CASHR_RPC_URL.
Use a Postgres CASHR_DATABASE_URL in production; see docs/DEPLOY.md.
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi>=0.115", "uvicorn[standard]>=0.30", "sqlalchemy>=2.0", "httpx>=0.27",
                 "psycopg[binary]>=3.2")
    .add_local_python_source("cashr")
)
volume = modal.Volume.from_name("cashr-data", create_if_missing=True)
app = modal.App("cashr-api")


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("cashr")],
    min_containers=1,
    max_containers=1,
    timeout=24 * 60 * 60,
)
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def api():
    import os

    os.environ.setdefault("CASHR_DATABASE_URL", "sqlite:////data/cashr.db")
    from cashr.app import create_app

    return create_app()
