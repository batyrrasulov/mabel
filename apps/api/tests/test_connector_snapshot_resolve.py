from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_resolve_connector_snapshot_prefers_enabled_alias_row() -> None:
    from mabel_api.catalog import connector_is_enabled, resolve_connector_snapshot
    from mabel_api.db import MemoryMabelStore
    from mabel_api.models import ConnectorSnapshot

    store = MemoryMabelStore()
    store.upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug="catalog",
            server_slug="google-analytics-mcp",
            name="Google Analytics",
            connection_status="not_configured",
            tools=[],
            enabled=False,
        )
    )
    store.upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug="local",
            server_slug="google-analytics",
            name="Google Analytics",
            connection_status="connected",
            tools=[{"name": "google_analytics_health_check"}],
            enabled=True,
        )
    )

    resolved = resolve_connector_snapshot(store, "google-analytics-mcp")
    assert resolved is not None
    assert resolved.server_slug == "google-analytics"
    assert connector_is_enabled(store, "google-analytics-mcp") is True


def test_set_all_connector_enabled_updates_alias_rows() -> None:
    from mabel_api.catalog import connector_is_enabled, set_all_connector_enabled
    from mabel_api.db import MemoryMabelStore
    from mabel_api.models import ConnectorSnapshot

    store = MemoryMabelStore()
    store.upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug="catalog",
            server_slug="google-analytics-mcp",
            name="Google Analytics",
            connection_status="connected",
            tools=[],
            enabled=True,
        )
    )
    store.upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug="local",
            server_slug="google-analytics",
            name="Google Analytics",
            connection_status="connected",
            tools=[],
            enabled=True,
        )
    )

    set_all_connector_enabled(store, "google-analytics-mcp", False)
    assert connector_is_enabled(store, "google-analytics-mcp") is False

    set_all_connector_enabled(store, "google-analytics-mcp", True)
    assert connector_is_enabled(store, "google-analytics-mcp") is True


def test_catalog_connector_status_treats_approved_as_launch_ready() -> None:
    from mabel_api.catalog import _connector_status, _seed_catalog_connectors
    from mabel_api.db import MemoryMabelStore

    payload = {
        "id": "connector.local-example",
        "status": "approved",
        "mcp": {"transport": "stdio", "command": "example-mcp"},
    }
    assert _connector_status(payload) == "local_package_available"

    store = MemoryMabelStore()
    _seed_catalog_connectors(store, settings=None)
    row = next((item for item in store.list_connectors() if item.server_slug == "local-example"), None)
    assert row is not None
    assert row.connection_status == "not_configured"
    assert row.enabled is False
    assert row.last_error is None
