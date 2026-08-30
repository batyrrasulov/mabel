from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .models import Skill, utcnow
from .settings import MabelSettings, repo_root


class SkillRegistryError(RuntimeError):
    pass


class SkillRegistryConfigError(SkillRegistryError):
    pass


class SkillRegistryAuthError(SkillRegistryError):
    pass


@dataclass(frozen=True)
class SkillRegistryEntry:
    id: str
    name: str
    owner_team: str
    status: str
    version: str
    content_md: str
    tags: list[str]
    mcp_bindings: list[dict[str, Any]]
    source: dict[str, Any]
    description: str

    def to_payload(self, *, include_content: bool = False) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "name": self.name,
            "owner_team": self.owner_team,
            "status": self.status,
            "current_version": self.version,
            "tags": self.tags,
            "mcp_bindings": self.mcp_bindings,
            "source": self.source,
            "description": self.description,
        }
        if include_content:
            payload["content_md"] = self.content_md
        return payload


def upsert_marketplace_skills(store, entries: list[SkillRegistryEntry]) -> list[Skill]:
    synced: list[Skill] = []
    for entry in entries:
        existing = store.get_skill(entry.id)
        merged_source = dict(entry.source or {})
        if existing and isinstance(existing.source, dict):
            prior_share = existing.source.get("share")
            if isinstance(prior_share, dict) and prior_share and not merged_source.get("share"):
                merged_source["share"] = prior_share
            prior_visibility = existing.source.get("visibility")
            if prior_visibility and not merged_source.get("visibility"):
                merged_source["visibility"] = prior_visibility
        skill = Skill(
            id=entry.id,
            name=entry.name,
            owner_team=entry.owner_team,
            status=_mabel_skill_status(entry.status),
            current_version=entry.version,
            content_md=entry.content_md,
            tags=entry.tags,
            mcp_bindings=entry.mcp_bindings,
            source=merged_source,
            created_at=existing.created_at if existing else utcnow(),
        )
        if existing:
            synced.append(store.update_skill(skill))
        else:
            synced.append(store.create_skill(skill))
    return synced


class GitHubSkillRegistry:
    def __init__(self, settings: MabelSettings, *, target_repo: str | None = None, ref: str | None = None) -> None:
        self.settings = settings
        self.repo = (target_repo or settings.skills_github_repo or "").strip()
        self.ref = (ref or settings.skills_github_ref or "main").strip()
        self.base_path = (settings.skills_github_base_path or "").strip().strip("/")
        self.token = settings.skills_github_token or settings.github_token
        if "/" not in self.repo:
            raise SkillRegistryConfigError("MABEL_SKILLS_GITHUB_REPO must be owner/repo")

    def fetch_marketplace(self) -> list[SkillRegistryEntry]:
        tree = self._get_json(f"/repos/{self.repo}/git/trees/{quote(self.ref, safe='')}?recursive=1")
        objects = tree.get("tree") if isinstance(tree, dict) else None
        if not isinstance(objects, list):
            raise SkillRegistryError("GitHub tree response did not include files")

        blob_paths = [
            str(obj.get("path"))
            for obj in objects
            if obj.get("type") == "blob" and str(obj.get("path") or "")
        ]
        manifest_paths = [
            path
            for path in blob_paths
            if path.endswith("/manifest.json")
        ]
        if self.base_path:
            manifest_paths = [path for path in manifest_paths if path == f"{self.base_path}/manifest.json" or path.startswith(f"{self.base_path}/")]

        entries: list[SkillRegistryEntry] = []
        manifest_package_dirs: set[str] = set()
        for manifest_path in sorted(manifest_paths)[:150]:
            try:
                manifest_text, manifest_sha = self._get_file_text(manifest_path)
                manifest = json.loads(manifest_text)
            except Exception:
                continue
            if not isinstance(manifest, dict) or manifest.get("type") != "skill":
                continue
            package_dir = manifest_path.rsplit("/", 1)[0]
            manifest_package_dirs.add(package_dir)
            instruction_file = (
                ((manifest.get("entrypoints") or {}).get("instruction_file") if isinstance(manifest.get("entrypoints"), dict) else None)
                or "SKILL.md"
            )
            try:
                content_md, content_sha = self._get_file_text(f"{package_dir}/{instruction_file}")
            except Exception:
                content_md, content_sha = "", None
            entries.append(self._entry_from_manifest(manifest, package_dir, manifest_sha, content_sha, content_md))

        skill_md_paths = [path for path in blob_paths if path.endswith("/SKILL.md") or path == "SKILL.md"]
        if self.base_path:
            skill_md_paths = [path for path in skill_md_paths if path == f"{self.base_path}/SKILL.md" or path.startswith(f"{self.base_path}/")]
        for skill_md_path in sorted(skill_md_paths)[:150]:
            package_dir = skill_md_path.rsplit("/", 1)[0] if "/" in skill_md_path else ""
            if package_dir in manifest_package_dirs:
                continue
            try:
                content_md, content_sha = self._get_file_text(skill_md_path)
            except Exception:
                continue
            entries.append(self._entry_from_skill_md(skill_md_path, package_dir, content_sha, content_md))
        return entries

    def push_skill(
        self,
        skill: Skill,
        *,
        requested_by: str,
        target_repo: str | None = None,
        base_ref: str | None = None,
        visibility: str = "team",
        commit_message: str | None = None,
    ) -> dict[str, Any]:
        if not self.token:
            raise SkillRegistryAuthError("GitHub token is required to share skills")
        registry = GitHubSkillRegistry(self.settings, target_repo=target_repo or self.repo, ref=base_ref or self.ref)
        if not registry.token:
            raise SkillRegistryAuthError("GitHub token is required to share skills")

        base_ref_name = registry.ref
        branch = f"mabel-skill/{_slug(requested_by.split('@', 1)[0])}/{_slug(skill.id)}-{_timestamp()}"
        base_sha = registry._get_branch_sha(base_ref_name)
        registry._post_json(f"/repos/{registry.repo}/git/refs", {"ref": f"refs/heads/{branch}", "sha": base_sha})

        package_dir = _skill_package_path(skill)
        manifest = _manifest_for_skill(skill, repo=registry.repo, path=package_dir, ref=branch, visibility=visibility, requested_by=requested_by)
        message = commit_message or f"Share {skill.id} from Mabel"
        files = [
            registry._put_file_text(
                f"{package_dir}/manifest.json",
                json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                branch=branch,
                message=message,
            ),
            registry._put_file_text(
                f"{package_dir}/SKILL.md",
                skill.content_md.rstrip() + "\n",
                branch=branch,
                message=message,
            ),
        ]
        return {
            "status": "shared",
            "repo": registry.repo,
            "base_ref": base_ref_name,
            "branch": branch,
            "path": package_dir,
            "files": files,
            "compare_url": f"https://github.com/{registry.repo}/compare/{quote(base_ref_name, safe='')}...{quote(branch, safe='')}",
        }

    def _entry_from_manifest(
        self,
        manifest: dict[str, Any],
        package_dir: str,
        manifest_sha: str | None,
        content_sha: str | None,
        content_md: str,
    ) -> SkillRegistryEntry:
        owner = manifest.get("owner") if isinstance(manifest.get("owner"), dict) else {}
        lifecycle = manifest.get("lifecycle") if isinstance(manifest.get("lifecycle"), dict) else {}
        contract = manifest.get("skill_contract") if isinstance(manifest.get("skill_contract"), dict) else {}
        dependencies = manifest.get("dependencies") if isinstance(manifest.get("dependencies"), list) else []
        mcp_bindings = [_binding_from_dependency(str(dep)) for dep in dependencies if str(dep).startswith("connector.")]
        source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
        manifest_visibility = str(manifest.get("visibility") or "").strip().lower()
        owner_contact = str(owner.get("contact") or "").strip()
        source = {
            **source,
            "type": "github",
            "repo": self.repo,
            "ref": self.ref,
            "path": package_dir,
            "manifest_sha": manifest_sha,
            "content_sha": content_sha,
            "html_url": f"https://github.com/{self.repo}/tree/{quote(self.ref, safe='')}/{package_dir}",
            "owner": owner,
        }
        if manifest_visibility in {"private", "team", "org", "public"}:
            source["visibility"] = manifest_visibility
            source["share"] = {
                "visibility": manifest_visibility,
                "shared_by": owner_contact or None,
            }
        return SkillRegistryEntry(
            id=str(manifest.get("id") or ""),
            name=str(manifest.get("name") or manifest.get("id") or ""),
            owner_team=str(owner.get("primary_team") or owner.get("team") or "shared"),
            status=_mabel_skill_status(str(lifecycle.get("status") or manifest.get("status") or "draft")),
            version=str(manifest.get("version") or "0.1.0"),
            content_md=content_md,
            tags=[str(tag) for tag in manifest.get("tags", []) if isinstance(tag, str)],
            mcp_bindings=mcp_bindings,
            source=source,
            description=str(contract.get("purpose") or ""),
        )

    def _entry_from_skill_md(
        self,
        skill_md_path: str,
        package_dir: str,
        content_sha: str | None,
        content_md: str,
    ) -> SkillRegistryEntry:
        metadata = _skill_md_frontmatter(content_md)
        fallback_slug = _slug(Path(package_dir or skill_md_path).name.removesuffix(".md"))
        name = str(metadata.get("name") or fallback_slug)
        skill_slug = _slug(name)
        source_path = package_dir or skill_md_path
        description = str(metadata.get("description") or _purpose_from_content(content_md))
        source = {
            "type": "github",
            "repo": self.repo,
            "ref": self.ref,
            "path": source_path,
            "content_sha": content_sha,
            "description": description,
            "html_url": f"https://github.com/{self.repo}/tree/{quote(self.ref, safe='')}/{quote(source_path, safe='/')}",
        }
        return SkillRegistryEntry(
            id=f"skill.{skill_slug}",
            name=name,
            owner_team=_owner_team_from_skill_path(package_dir),
            status="published",
            version=str(metadata.get("version") or "0.1.0"),
            content_md=content_md,
            tags=_tags_from_skill_path(package_dir),
            mcp_bindings=[],
            source=source,
            description=description,
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mabel-skills-registry",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _get_json(self, path: str) -> dict[str, Any]:
        with httpx.Client(base_url="https://api.github.com", headers=self._headers(), timeout=20.0) as client:
            response = client.get(path)
        if response.status_code in {401, 403}:
            raise SkillRegistryAuthError("GitHub rejected the configured token")
        if response.status_code == 404:
            raise SkillRegistryError(f"GitHub resource not found for {self.repo}@{self.ref}")
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise SkillRegistryError("GitHub response was not an object")
        return data

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        with httpx.Client(base_url="https://api.github.com", headers=self._headers(), timeout=20.0) as client:
            response = client.post(path, json=payload)
        if response.status_code in {401, 403}:
            raise SkillRegistryAuthError("GitHub rejected the configured token")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    def _put_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        with httpx.Client(base_url="https://api.github.com", headers=self._headers(), timeout=20.0) as client:
            response = client.put(path, json=payload)
        if response.status_code in {401, 403}:
            raise SkillRegistryAuthError("GitHub rejected the configured token")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    def _get_file_text(self, path: str, *, ref: str | None = None) -> tuple[str, str | None]:
        data = self._get_json(f"/repos/{self.repo}/contents/{quote(path, safe='/')}?ref={quote(ref or self.ref, safe='')}")
        if data.get("type") != "file":
            raise SkillRegistryError(f"{path} is not a file")
        raw = str(data.get("content") or "")
        if data.get("encoding") != "base64":
            raise SkillRegistryError(f"{path} is not base64 encoded")
        return base64.b64decode(raw).decode("utf-8"), data.get("sha") if isinstance(data.get("sha"), str) else None

    def _get_branch_sha(self, ref: str) -> str:
        data = self._get_json(f"/repos/{self.repo}/git/ref/heads/{quote(ref, safe='')}")
        obj = data.get("object") if isinstance(data.get("object"), dict) else {}
        sha = obj.get("sha")
        if not isinstance(sha, str) or not sha:
            raise SkillRegistryError(f"GitHub ref {ref} did not include a sha")
        return sha

    def _content_sha_or_none(self, path: str, *, ref: str) -> str | None:
        try:
            _, sha = self._get_file_text(path, ref=ref)
            return sha
        except SkillRegistryError:
            return None

    def _put_file_text(self, path: str, text: str, *, branch: str, message: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "message": message,
            "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
            "branch": branch,
        }
        existing_sha = self._content_sha_or_none(path, ref=branch)
        if existing_sha:
            payload["sha"] = existing_sha
        data = self._put_json(f"/repos/{self.repo}/contents/{quote(path, safe='/')}", payload)
        content = data.get("content") if isinstance(data.get("content"), dict) else {}
        return {
            "path": path,
            "sha": content.get("sha"),
            "html_url": content.get("html_url"),
        }


class LocalSkillRegistry:
    """Read Mabel skill packages from the checked-out repository.

    GitHub remains an optional publish/share source of truth. This fallback keeps
    local development usable without a remote registry or token.
    """

    def __init__(self, settings: MabelSettings) -> None:
        self.settings = settings
        root = repo_root()
        candidates: list[Path] = []
        if settings.skills_github_base_path:
            configured = Path(settings.skills_github_base_path)
            candidates.append(configured if configured.is_absolute() else root / configured)
        candidates.append(root / "packages" / "skills")
        self.base_dir = next((path for path in candidates if path.exists()), candidates[-1])

    def fetch_marketplace(self) -> list[SkillRegistryEntry]:
        if not self.base_dir.exists():
            raise SkillRegistryError(f"Local skills marketplace not found at {self.base_dir}")
        root = repo_root()
        entries: list[SkillRegistryEntry] = []
        for manifest_path in sorted(self.base_dir.glob("*/manifest.json"))[:150]:
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(manifest, dict) or manifest.get("type") != "skill":
                continue
            instruction_file = (
                ((manifest.get("entrypoints") or {}).get("instruction_file") if isinstance(manifest.get("entrypoints"), dict) else None)
                or "SKILL.md"
            )
            content_path = manifest_path.parent / str(instruction_file)
            try:
                content_md = content_path.read_text(encoding="utf-8")
            except Exception:
                content_md = ""
            try:
                package_dir = manifest_path.parent.relative_to(root).as_posix()
            except ValueError:
                package_dir = manifest_path.parent.as_posix()
            entries.append(self._entry_from_manifest(manifest, package_dir, content_md))
        return entries

    def _entry_from_manifest(
        self,
        manifest: dict[str, Any],
        package_dir: str,
        content_md: str,
    ) -> SkillRegistryEntry:
        owner = manifest.get("owner") if isinstance(manifest.get("owner"), dict) else {}
        lifecycle = manifest.get("lifecycle") if isinstance(manifest.get("lifecycle"), dict) else {}
        contract = manifest.get("skill_contract") if isinstance(manifest.get("skill_contract"), dict) else {}
        dependencies = manifest.get("dependencies") if isinstance(manifest.get("dependencies"), list) else []
        mcp_bindings = [_binding_from_dependency(str(dep)) for dep in dependencies if str(dep).startswith("connector.")]
        source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
        source = {
            **source,
            "type": "local",
            "repo": self.settings.github_repo,
            "ref": "local",
            "path": package_dir,
            "local_path": str(repo_root() / package_dir),
        }
        return SkillRegistryEntry(
            id=str(manifest.get("id") or ""),
            name=str(manifest.get("name") or manifest.get("id") or ""),
            owner_team=str(owner.get("primary_team") or owner.get("team") or "shared"),
            status=_mabel_skill_status(str(lifecycle.get("status") or manifest.get("status") or "draft")),
            version=str(manifest.get("version") or "0.1.0"),
            content_md=content_md,
            tags=[str(tag) for tag in manifest.get("tags", []) if isinstance(tag, str)],
            mcp_bindings=mcp_bindings,
            source=source,
            description=str(contract.get("purpose") or ""),
        )


def _mabel_skill_status(status: str) -> str:
    from .catalog import normalize_skill_status

    return normalize_skill_status(status)


def _binding_from_dependency(dependency: str) -> dict[str, Any]:
    slug = dependency.removeprefix("connector.")
    return {"server_slug": slug, "connector_id": dependency}


def _skill_md_frontmatter(content_md: str) -> dict[str, Any]:
    lines = content_md.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    end_idx = next((idx for idx, line in enumerate(lines[1:], start=1) if line.strip() == "---"), None)
    if end_idx is None:
        return {}

    metadata: dict[str, Any] = {}
    block = lines[1:end_idx]
    idx = 0
    while idx < len(block):
        line = block[idx]
        match = re.match(r"^([A-Za-z0-9_-]+):(?:\s*(.*))?$", line)
        if not match:
            idx += 1
            continue
        key, raw_value = match.group(1), (match.group(2) or "").strip()
        if raw_value in {">", "|"}:
            folded: list[str] = []
            idx += 1
            while idx < len(block):
                next_line = block[idx]
                if re.match(r"^[A-Za-z0-9_-]+:", next_line):
                    break
                folded.append(next_line.strip())
                idx += 1
            text = "\n".join(folded).strip() if raw_value == "|" else " ".join(part for part in folded if part).strip()
            metadata[key] = text
            continue
        if raw_value.startswith("[") and raw_value.endswith("]"):
            metadata[key] = [
                part.strip().strip("\"'")
                for part in raw_value.strip("[]").split(",")
                if part.strip()
            ]
        else:
            metadata[key] = raw_value.strip("\"'")
        idx += 1
    return metadata


def _owner_team_from_skill_path(package_dir: str) -> str:
    parts = [part for part in package_dir.split("/") if part]
    if len(parts) >= 2 and parts[0] == "library":
        return parts[1]
    if parts:
        return parts[0]
    return "shared"


def _tags_from_skill_path(package_dir: str) -> list[str]:
    tags = [_slug(part) for part in package_dir.split("/") if part and part != "library"]
    return sorted({tag for tag in tags if tag})


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9.-]+", "-", value.lower()).strip("-")
    return normalized or "skill"


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def _skill_package_path(skill: Skill) -> str:
    source_path = skill.source.get("path") if isinstance(skill.source, dict) else None
    if isinstance(source_path, str) and source_path.startswith("packages/skills/"):
        return source_path
    return f"packages/skills/{_slug(skill.id.removeprefix('skill.'))}"


def _manifest_for_skill(
    skill: Skill,
    *,
    repo: str,
    path: str,
    ref: str,
    visibility: str,
    requested_by: str,
) -> dict[str, Any]:
    dependencies: list[str] = []
    for binding in skill.mcp_bindings:
        raw_slug = binding.get("server_slug") or binding.get("connector_slug") or binding.get("server") or binding.get("connector")
        if not raw_slug:
            continue
        slug = str(raw_slug)
        dependencies.append(slug if slug.startswith("connector.") else f"connector.{slug}")
    dependencies = sorted(set(dependencies))
    purpose = _purpose_from_skill(skill)
    return {
        "id": skill.id,
        "type": "skill",
        "name": skill.name,
        "version": skill.current_version or "0.1.0",
        "owner": {"primary_team": skill.owner_team, "contact": requested_by, "teams": [skill.owner_team]},
        "supported_hosts": ["mabel"],
        "dependencies": dependencies,
        "visibility": visibility,
        "entrypoints": {"instruction_file": "SKILL.md", "input_schema": None, "output_schema": None},
        "docs_path": "README.md",
        "changelog_path": "CHANGELOG.md",
        "source": {"type": "github", "repo": repo, "path": path, "ref": ref},
        "tags": skill.tags,
        "data_classification": "internal",
        "lifecycle": {"status": "published"},
        "approval": {"policy": "mabel-org-shared"},
        "install": {"method": "mabel_marketplace", "config_targets": ["mabel"]},
        "skill_contract": {
            "purpose": purpose,
            "input_contract": "User prompt plus any fields declared in SKILL.md.",
            "output_contract": "A source-backed Mabel response or artifact, with controlled actions paused for approval.",
        },
    }


def _purpose_from_skill(skill: Skill) -> str:
    return _purpose_from_content(skill.content_md) or f"Mabel skill {skill.name}"


def _purpose_from_content(content_md: str) -> str:
    for line in content_md.splitlines():
        clean = line.strip().lstrip("#").strip()
        if clean and clean != "---" and not clean.startswith("<!--") and not re.match(r"^[A-Za-z0-9_-]+:", clean):
            return clean[:500]
    return ""
