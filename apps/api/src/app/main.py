"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.routers import auth, centres, classes, join, roster

app = FastAPI(title="Coding-teaching-tool API")

app.include_router(auth.router)
app.include_router(centres.router)
app.include_router(classes.router)
app.include_router(roster.students_router)
app.include_router(roster.roster_router)
app.include_router(join.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
