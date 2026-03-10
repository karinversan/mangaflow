from __future__ import annotations

from app.db.base import Base
from app.db.migrate import run_migrations
from app.db.session import engine


def main() -> None:
    run_migrations(engine)
    Base.metadata.create_all(bind=engine)
    print("migrations applied")


if __name__ == "__main__":
    main()
