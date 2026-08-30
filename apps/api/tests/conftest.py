from __future__ import annotations

import os


def pytest_configure() -> None:
    # Unit tests exercise the reverse-proxy identity contract explicitly.
    os.environ.setdefault("MABEL_AUTH_MODE", "trusted_headers")
    os.environ.setdefault("MABEL_STORE_MODE", "memory")
    os.environ.setdefault("MABEL_OPENAI_AGENTS_ENABLED", "false")
