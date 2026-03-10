from __future__ import annotations

from app.db.models import Project, User
from app.db.session import SessionLocal


def main() -> None:
    db = SessionLocal()
    try:
        user = db.get(User, "demo-user")
        if user is None:
            user = User(id="demo-user", email="demo@example.com")
            db.add(user)
            db.flush()
        project = (
            db.query(Project)
            .filter(Project.owner_id == user.id, Project.name == "Demo project")
            .one_or_none()
        )
        if project is None:
            project = Project(owner_id=user.id, created_by=user.id, updated_by=user.id, name="Demo project")
            db.add(project)
        db.commit()
        print("seed completed")
    finally:
        db.close()


if __name__ == "__main__":
    main()
