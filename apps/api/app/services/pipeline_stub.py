from app.schemas.pipeline import PipelineResponse
from app.services.providers import StubProvider


def run_stub_pipeline(file_bytes: bytes, target_lang: str) -> PipelineResponse:
    return StubProvider().run(file_bytes=file_bytes, target_lang=target_lang)
