"""FastAPI application entrypoint.

Phase 1 step 1: a health check and nothing else. Routers land in steps 3–8.
"""

from fastapi import FastAPI

app = FastAPI(title="Coding-teaching-tool API")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
