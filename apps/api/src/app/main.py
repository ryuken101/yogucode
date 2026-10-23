"""FastAPI application entrypoint."""

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from app.limits import BodySizeLimit, validation_error
from app.routers import (
    auth,
    centres,
    class_teachers,
    classes,
    curriculum,
    desktop,
    documents,
    events,
    folders,
    homework,
    items,
    join,
    live,
    marking,
    progress,
    quiz,
    roster,
    student_files,
    student_work,
    teacher_documents,
    teachers,
    trash,
)
from app.trash import purge_loop

# The Trash's 30-day purge runs while the API is up. Production serves the API mounted
# inside `app.server:site`, whose own lifespan starts it there (a mounted app's isn't run).
app = FastAPI(title="Yogucode API", lifespan=purge_loop)
app.add_middleware(BodySizeLimit)
app.add_exception_handler(RequestValidationError, validation_error)

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
app.include_router(folders.student_router)
app.include_router(folders.teacher_router)
app.include_router(student_files.router)
app.include_router(desktop.router)
app.include_router(trash.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
