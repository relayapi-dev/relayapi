#!/usr/bin/env python3
"""Fail closed when critical workflows regain mutable dependencies."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIRECTORY = REPO_ROOT / ".github/workflows"
WORKFLOWS = tuple(
    str(path.relative_to(REPO_ROOT))
    for pattern in ("*.yml", "*.yaml")
    for path in sorted(WORKFLOW_DIRECTORY.glob(pattern))
)
PUBLISH_WORKFLOWS = (
    ".github/workflows/publish-sdk.yml",
    ".github/workflows/publish-cli.yml",
    ".github/workflows/publish-downloader.yml",
    ".github/workflows/publish-integrations.yml",
    ".github/workflows/publish-mcp-server.yml",
    ".github/workflows/publish-self-host.yml",
    ".github/workflows/publish-n8n-node.yml",
    ".github/workflows/publish-zapier.yml",
)
RELEASE_WORKFLOWS = (
    ".github/workflows/publish-sdk.yml",
    ".github/workflows/publish-cli.yml",
    ".github/workflows/publish-mcp-server.yml",
    ".github/workflows/publish-self-host.yml",
)
EXPECTED_ACTIONS = {
    "actions/checkout": {
        ("34e114876b0b11c390a56381ad16ebd13914f8d5", "v4.3.1"),
        ("df4cb1c069e1874edd31b4311f1884172cec0e10", "v6.0.3"),
    },
    "actions/setup-node": {
        ("49933ea5288caeca8642d1e84afbd3f7d6820020", "v4.4.0"),
    },
    "actions/setup-python": {
        ("ece7cb06caefa5fff74198d8649806c4678c61a1", "v6.3.0"),
    },
    "astral-sh/setup-uv": {
        ("f98e06938123ccabd21905ea5d0069192241f9f1", "v8.3.2"),
    },
    "docker/build-push-action": {
        ("53b7df96c91f9c12dcc8a07bcb9ccacbed38856a", "v7.3.0"),
    },
    "docker/login-action": {
        ("af1e73f918a031802d376d3c8bbc3fe56130a9b0", "v4.4.0"),
    },
    "docker/setup-buildx-action": {
        ("bb05f3f5519dd87d3ba754cc423b652a5edd6d2c", "v4.2.0"),
    },
    "docker/setup-qemu-action": {
        ("96fe6ef7f33517b61c61be40b68a1882f3264fb8", "v4.2.0"),
    },
    "googleapis/release-please-action": {
        ("5c625bfb5d1ff62eadeeb3772007f7f66fdcf071", "v4.4.1"),
    },
    "oven-sh/setup-bun": {
        ("0c5077e51419868618aeaa5fe8019c62421857d6", "v2.2.0"),
    },
}
ACTION_LINE = re.compile(
    r"^\s*(?:-\s*)?(?:uses|['\"]uses['\"]):\s+"
    r"([^@\s#]+)@([0-9a-f]{40})\s+#\s+(v\d+(?:\.\d+){1,2})\s*$"
)
USES_TOKEN = re.compile(r"(?:^|[\s{,\-])(?:uses|['\"]uses['\"]):")
EXPECTED_NODE_VERSIONS = {
    ".github/workflows/ci-packages.yml": ("18.20.8", "22.12.0"),
    ".github/workflows/publish-cli.yml": ("22.12.0",),
    ".github/workflows/publish-integrations.yml": ("22.12.0", "22.12.0"),
    ".github/workflows/publish-mcp-server.yml": ("18.20.8", "22.12.0"),
    ".github/workflows/publish-self-host.yml": ("22.12.0",),
    ".github/workflows/publish-n8n-node.yml": ("22.12.0",),
    ".github/workflows/publish-sdk.yml": ("22.12.0",),
    ".github/workflows/publish-zapier.yml": ("22.12.0",),
}
EXPECTED_JOB_PERMISSIONS = {
    ".github/workflows/publish-downloader.yml": {
        "build-and-push": {"contents": "read", "packages": "write"},
    },
    ".github/workflows/publish-integrations.yml": {
        "publish-openclaw": {"contents": "read"},
        "validate-claude-plugin": {"contents": "read"},
    },
    ".github/workflows/publish-n8n-node.yml": {
        "publish": {"contents": "read", "id-token": "write"},
    },
    ".github/workflows/publish-zapier.yml": {
        "push": {"contents": "read"},
    },
}


def fail(message: str) -> None:
    print(f"workflow supply-chain check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def job_block(text: str, name: str) -> str:
    try:
        jobs_text = text.split("\njobs:\n", maxsplit=1)[1]
    except IndexError:
        fail("missing jobs mapping")
    lines = jobs_text.splitlines()
    marker = f"  {name}:"
    try:
        start = lines.index(marker)
    except ValueError:
        fail(f"missing job {name!r}")

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.fullmatch(r"  [a-zA-Z0-9_-]+:", lines[index]):
            end = index
            break
    return "\n".join(lines[start:end])


def direct_permissions(block: str, indent: int) -> dict[str, str]:
    lines = block.splitlines()
    marker = f"{' ' * indent}permissions:"
    try:
        start = lines.index(marker)
    except ValueError:
        fail("missing explicit permissions block")

    permissions: dict[str, str] = {}
    item_prefix = " " * (indent + 2)
    for line in lines[start + 1 :]:
        if not line.startswith(item_prefix) or line.startswith(item_prefix + " "):
            break
        key, separator, value = line.strip().partition(":")
        if not separator or not value.strip():
            fail(f"malformed permissions entry {line!r}")
        permissions[key] = value.strip()
    return permissions


def verify_actions(path: str, text: str) -> None:
    uses_lines = [
        line
        for line in text.splitlines()
        if not line.lstrip().startswith("#") and USES_TOKEN.search(line)
    ]
    reviewed_actions: list[str] = []
    for line in uses_lines:
        match = ACTION_LINE.fullmatch(line)
        if match is None:
            fail(f"{path} has a mutable or uncommented action reference: {line.strip()}")
        action, sha, version = match.groups()
        reviewed_actions.append(action)
        expected_pins = EXPECTED_ACTIONS.get(action)
        if expected_pins is None:
            fail(f"{path} uses an unreviewed action: {action}")
        if (sha, version) not in expected_pins:
            formatted_pins = ", ".join(
                f"{expected_sha} ({expected_version})"
                for expected_sha, expected_version in sorted(expected_pins)
            )
            fail(
                f"{path} {action} must be reviewed and updated in the allowlist; "
                f"expected one of: {formatted_pins}"
            )

    checkout_count = reviewed_actions.count("actions/checkout")
    if text.count("persist-credentials: false") != checkout_count:
        fail(f"{path} must disable persisted checkout credentials on every checkout")

    bun_count = reviewed_actions.count("oven-sh/setup-bun")
    if text.count('bun-version: "1.3.14"') != bun_count:
        fail(f"{path} must pin every setup-bun step to Bun 1.3.14")
    if "bun-version: latest" in text:
        fail(f"{path} must not install the mutable latest Bun version")

    node_versions = tuple(
        sorted(
            re.findall(
                r'^\s+node-version:\s*["\']([^"\']+)["\']\s*$',
                text,
                re.MULTILINE,
            )
        )
    )
    node_count = reviewed_actions.count("actions/setup-node")
    expected_node_versions = tuple(sorted(EXPECTED_NODE_VERSIONS.get(path, ())))
    if len(node_versions) != node_count or node_versions != expected_node_versions:
        fail(
            f"{path} Node pins do not match reviewed runtimes: "
            f"expected {expected_node_versions}, found {node_versions}"
        )

    python_count = reviewed_actions.count("actions/setup-python")
    if python_count and text.count('python-version: "3.14.6"') != python_count:
        fail(f"{path} must pin every setup-python step to Python 3.14.6")

    uv_count = reviewed_actions.count("astral-sh/setup-uv")
    if uv_count and text.count('version: "0.11.29"') != uv_count:
        fail(f"{path} must pin every setup-uv step to uv 0.11.29")


def verify_release_permissions(path: str, text: str) -> None:
    before_jobs = text.split("\njobs:\n", maxsplit=1)[0]
    if not re.search(r"^permissions:\s*\{\}\s*$", before_jobs, re.MULTILINE):
        fail(f"{path} must deny permissions by default")

    release = direct_permissions(job_block(text, "release-please"), 4)
    if release != {"contents": "write", "pull-requests": "write"}:
        fail(f"{path} release-please permissions are not least-privilege: {release}")

    publish = direct_permissions(job_block(text, "publish"), 4)
    if publish != {"contents": "read", "id-token": "write"}:
        fail(f"{path} publish permissions are not least-privilege: {publish}")

    if path.endswith("publish-mcp-server.yml"):
        runtime_floor = direct_permissions(job_block(text, "runtime-floor"), 4)
        if runtime_floor != {"contents": "read"}:
            fail(f"{path} runtime-floor permissions are too broad: {runtime_floor}")
        publish_block = job_block(text, "publish")
        if "needs: [release-please, runtime-floor]" not in publish_block:
            fail(f"{path} publish must wait for the Node 18 runtime floor")


def verify_direct_publish_permissions(path: str, text: str) -> None:
    before_jobs = text.split("\njobs:\n", maxsplit=1)[0]
    if not re.search(r"^permissions:\s*\{\}\s*$", before_jobs, re.MULTILINE):
        fail(f"{path} must deny permissions by default")

    for job_name, expected in EXPECTED_JOB_PERMISSIONS[path].items():
        block = job_block(text, job_name)
        actual = direct_permissions(block, 4)
        if actual != expected:
            fail(f"{path} {job_name} permissions are not least-privilege: {actual}")

    publishing_job = next(iter(EXPECTED_JOB_PERMISSIONS[path]))
    block = job_block(text, publishing_job)
    protected_main_gate = (
        "if: ${{ github.ref == 'refs/heads/main' && github.ref_protected }}"
    )
    if protected_main_gate not in block:
        fail(f"{path} {publishing_job} must require the protected main branch")


def verify_read_only_permissions(path: str, text: str) -> None:
    before_jobs = text.split("\njobs:\n", maxsplit=1)[0]
    permissions = direct_permissions(before_jobs, 0)
    if permissions != {"contents": "read"}:
        fail(f"{path} workflow permissions are not read-only: {permissions}")

    try:
        jobs_text = text.split("\njobs:\n", maxsplit=1)[1]
    except IndexError:
        fail(f"{path} is missing its jobs mapping")
    for match in re.finditer(
        r"^ {4}(?:permissions|['\"]permissions['\"]):(.*)$",
        jobs_text,
        re.MULTILINE,
    ):
        if match.group(1).strip() != "{}":
            fail(f"{path} must not elevate read-only permissions at job scope")

    jobs_text = text.split("\njobs:\n", maxsplit=1)[1]
    for match in re.finditer(r"(?m)^  ([a-zA-Z0-9_-]+):\s*$", jobs_text):
        name = match.group(1)
        block = job_block(text, name)
        declarations = [
            line for line in block.splitlines() if line.startswith("    permissions:")
        ]
        if len(declarations) > 1:
            fail(f"{path} {name} has multiple permissions declarations")
        if not declarations:
            continue
        inline = declarations[0].partition(":")[2].strip()
        job_permissions = {} if inline == "{}" else direct_permissions(block, 4)
        if job_permissions not in ({}, {"contents": "read"}):
            fail(
                f"{path} {name} escalates read-only workflow permissions: "
                f"{job_permissions}"
            )


def main() -> None:
    discovered_publishers = {
        str(path.relative_to(REPO_ROOT))
        for pattern in (
            "publish-*.yml",
            "publish-*.yaml",
            "release-*.yml",
            "release-*.yaml",
        )
        for path in WORKFLOW_DIRECTORY.glob(pattern)
    }
    if discovered_publishers != set(PUBLISH_WORKFLOWS):
        fail(
            "artifact publisher inventory changed; review and update the allowlist: "
            f"{sorted(discovered_publishers ^ set(PUBLISH_WORKFLOWS))}"
        )

    for path in WORKFLOWS:
        text = (REPO_ROOT / path).read_text(encoding="utf-8")
        verify_actions(path, text)
        if path in RELEASE_WORKFLOWS:
            verify_release_permissions(path, text)
        elif path in EXPECTED_JOB_PERMISSIONS:
            verify_direct_publish_permissions(path, text)
        else:
            verify_read_only_permissions(path, text)

    deploy_api = (REPO_ROOT / ".github/workflows/deploy-api.yml").read_text(
        encoding="utf-8"
    )
    required_images = (
        "postgres:18-alpine@sha256:"
        "9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15",
        "cloudflare/cloudflared:2026.6.0@sha256:"
        "ba461b8aa9c042156dbd39c38657fe7431bafa063220eab8d5330a523863da9f",
    )
    for image in required_images:
        if image not in deploy_api:
            fail(f"deploy-api.yml must use reviewed image {image}")

    ci_db = (WORKFLOW_DIRECTORY / "ci-db-migrations.yml").read_text(encoding="utf-8")
    if required_images[0] not in ci_db:
        fail(f"ci-db-migrations.yml must use reviewed image {required_images[0]}")

    downloader = (WORKFLOW_DIRECTORY / "publish-downloader.yml").read_text(
        encoding="utf-8"
    )
    required_downloader_toolchains = (
        "--python 3.14.6",
        "docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:"
        "400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0",
        'version: "v0.35.0"',
        "image=moby/buildkit:v0.31.2@sha256:"
        "2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec",
    )
    for toolchain in required_downloader_toolchains:
        if toolchain not in downloader:
            fail(f"publish-downloader.yml must use reviewed toolchain {toolchain}")

    integrations = (WORKFLOW_DIRECTORY / "publish-integrations.yml").read_text(
        encoding="utf-8"
    )
    for tool in ("clawhub@0.23.1", "@anthropic-ai/claude-code@2.1.214"):
        if tool not in integrations:
            fail(f"publish-integrations.yml must install reviewed tool {tool}")

    n8n = (WORKFLOW_DIRECTORY / "publish-n8n-node.yml").read_text(encoding="utf-8")
    if "npm publish --provenance --access public" not in n8n:
        fail("publish-n8n-node.yml must attach npm provenance")

    supply_chain_ci = (
        WORKFLOW_DIRECTORY / "ci-workflow-supply-chain.yml"
    ).read_text(encoding="utf-8")
    for tool in (
        "ACTIONLINT_VERSION: 1.7.12",
        "ACTIONLINT_SHA256: "
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    ):
        if tool not in supply_chain_ci:
            fail(f"ci-workflow-supply-chain.yml must install reviewed tool {tool}")

    print(f"verified immutable dependencies in {len(WORKFLOWS)} critical workflows")


if __name__ == "__main__":
    main()
