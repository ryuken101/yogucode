"""Write the OpenAPI schema to disk, for the frontend's type generator.

`apps/web` turns this file into TypeScript, so the browser code and the API cannot quietly
disagree about a response shape. Committing the JSON rather than fetching it at build time
means the web build needs no Python, no database and no running server — it reads a file.

This imports the app but never connects to anything: `app.openapi()` is built from the
Pydantic models alone. Run it after changing any request or response model.

    uv run python -m app.openapi_dump

CI runs the same command and fails if the result differs from what is committed, so a
changed response model that nobody regenerated breaks the build rather than the frontend.
"""

import json
from pathlib import Path

from app.main import app

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "openapi.json"


def main() -> None:
    # sort_keys so the file is a stable diff rather than a reshuffle on every run, and a
    # trailing newline so it reads as an ordinary text file to git and to editors.
    SCHEMA_PATH.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
