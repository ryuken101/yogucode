"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.routers import auth, centres, classes

app = FastAPI(title="Coding-teaching-tool API")

app.include_router(auth.router)
app.include_router(centres.router)
app.include_router(classes.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
