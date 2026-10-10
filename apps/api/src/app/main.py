"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.routers import (
    auth,
    centres,
    class_teachers,
    classes,
    curriculum,
    documents,
    events,
    homework,
    items,
    join,
    live,
    marking,
    progress,
    quiz,
    roster,
    student_work,
    teacher_documents,
    teachers,
)

app = FastAPI(title="Yogucode API")

app.include_router(auth.router)
app.include_router(centres.router)
app.include_router(classes.router)
app.include_router(class_teachers.router)
app.include_router(roster.students_router)
app.include_router(roster.roster_router)
app.include_router(join.router)
app.include_router(documents.router)
app.include_router(curriculum.router)
app.include_router(items.router)
app.include_router(student_work.router)
app.include_router(events.router)
app.include_router(homework.router)
app.include_router(marking.router)
app.include_router(progress.router)
app.include_router(live.router)
app.include_router(quiz.router)
app.include_router(teachers.router)
app.include_router(teacher_documents.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
