#!/usr/bin/env python3
"""One-time backfill: publish legacy custom skills stuck in draft/review.

Backs up impacted rows to /tmp before updating mabel_api_skills and mabel_api_state.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg

CUSTOM_SOURCE_TYPES = ("chat_created", "database_draft")
TARGET_STATUSES = ("draft", "review")


def _skill_source_type(source: object) -> str:
    if not isinstance(source, dict):
        return ""
    return str(source.get("type") or "").strip().lower()


def main() -> int:
    db_url = os.environ.get("MABEL_DB_URL", "").strip()
    if not db_url:
        print("MABEL_DB_URL is required", file=sys.stderr)
        return 1

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = Path(f"/tmp/mabel_api_custom_skills_backfill_{stamp}.json")

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, owner_team, status, source, created_at, updated_at
                FROM mabel_api_skills
                WHERE lower(status) = ANY(%s)
                """,
                ([status.lower() for status in TARGET_STATUSES],),
            )
            rows = cur.fetchall()
            impacted = []
            for row in rows:
                skill_id, name, owner_team, status, source, created_at, updated_at = row
                if _skill_source_type(source) not in CUSTOM_SOURCE_TYPES:
                    continue
                impacted.append(
                    {
                        "id": skill_id,
                        "name": name,
                        "owner_team": owner_team,
                        "status": status,
                        "source": source,
                        "created_at": created_at.isoformat() if created_at else None,
                        "updated_at": updated_at.isoformat() if updated_at else None,
                    }
                )

            before_count = len(impacted)
            backup_path.write_text(json.dumps({"skills": impacted}, indent=2), encoding="utf-8")
            print(f"backup_file={backup_path}")
            print(f"before_count={before_count}")

            if not impacted:
                print("after_count=0")
                return 0

            skill_ids = [row["id"] for row in impacted]
            cur.execute(
                """
                UPDATE mabel_api_skills
                SET status = 'published', updated_at = NOW()
                WHERE id = ANY(%s)
                """,
                (skill_ids,),
            )
            skills_updated = cur.rowcount

            state_updated = 0
            cur.execute("SELECT payload FROM mabel_api_state WHERE state_key = 'default'")
            state_row = cur.fetchone()
            if state_row and isinstance(state_row[0], dict):
                payload = state_row[0]
                skills = payload.get("skills")
                if isinstance(skills, dict):
                    for skill_id in skill_ids:
                        entry = skills.get(skill_id)
                        if isinstance(entry, dict) and str(entry.get("status") or "").lower() in TARGET_STATUSES:
                            entry["status"] = "published"
                            state_updated += 1
                    cur.execute(
                        """
                        UPDATE mabel_api_state
                        SET payload = %s::jsonb, updated_at = NOW()
                        WHERE state_key = 'default'
                        """,
                        (json.dumps(payload),),
                    )

            conn.commit()
            print(f"skills_updated={skills_updated}")
            print(f"state_mirror_updated={state_updated}")
            print(f"after_count={skills_updated}")
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
