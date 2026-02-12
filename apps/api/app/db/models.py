from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    projects: Mapped[list[Project]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    owner: Mapped[User] = relationship(back_populates="projects")
    pages: Mapped[list[Page]] = relationship(back_populates="project", cascade="all, delete-orphan")
    job_runs: Mapped[list[JobRun]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (UniqueConstraint("project_id", "page_index", name="uq_pages_project_page_index"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    page_index: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    input_s3_key: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    project: Mapped[Project] = relationship(back_populates="pages")
    regions: Mapped[list[Region]] = relationship(back_populates="page", cascade="all, delete-orphan")
    job_runs: Mapped[list[JobRun]] = relationship(back_populates="page")


class Region(Base):
    __tablename__ = "regions"
    __table_args__ = (UniqueConstraint("page_id", "external_region_id", name="uq_regions_page_external_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    page_id: Mapped[str] = mapped_column(String(36), ForeignKey("pages.id", ondelete="CASCADE"), nullable=False)
    external_region_id: Mapped[str] = mapped_column(String(64), nullable=False)
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    width: Mapped[float] = mapped_column(Float, nullable=False)
    height: Mapped[float] = mapped_column(Float, nullable=False)
    source_text: Mapped[str] = mapped_column(Text, nullable=False)
    translated_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    review_status: Mapped[str] = mapped_column(String(16), nullable=False, default="todo")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    page: Mapped[Page] = relationship(back_populates="regions")


class JobRun(Base):
    __tablename__ = "job_runs"
    __table_args__ = (UniqueConstraint("owner_id", "request_id", name="uq_job_runs_owner_request"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    page_id: Mapped[str] = mapped_column(String(36), ForeignKey("pages.id", ondelete="CASCADE"), nullable=False)
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False, default="stub")
    target_lang: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_s3_key: Mapped[str] = mapped_column(String(512), nullable=False)
    output_json_s3_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    output_preview_s3_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    region_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    project: Mapped[Project] = relationship(back_populates="job_runs")
    page: Mapped[Page] = relationship(back_populates="job_runs")
