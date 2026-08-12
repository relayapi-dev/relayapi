from __future__ import annotations

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-workflow-supply-chain.py")
SPEC = importlib.util.spec_from_file_location("workflow_supply_chain", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not import {SCRIPT}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class WorkflowActionReferenceTests(unittest.TestCase):
    def assert_rejected(self, workflow: str) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                VERIFIER.verify_actions("fixture.yml", workflow)

    def test_rejects_mutable_step_action(self) -> None:
        self.assert_rejected("steps:\n  - uses: actions/checkout@v4\n")

    def test_rejects_mutable_reusable_workflow(self) -> None:
        self.assert_rejected(
            "jobs:\n"
            "  call:\n"
            "    uses: example/actions/.github/workflows/build.yml@main\n"
        )

    def test_rejects_unreviewed_sha_pinned_reusable_workflow(self) -> None:
        self.assert_rejected(
            "jobs:\n"
            "  call:\n"
            "    uses: example/actions/.github/workflows/build.yml@"
            "0123456789abcdef0123456789abcdef01234567 # v1.0.0\n"
        )

    def test_rejects_inline_or_quoted_uses_bypasses(self) -> None:
        self.assert_rejected("steps:\n  - { uses: actions/checkout@v4 }\n")
        self.assert_rejected("steps:\n  - 'uses': actions/checkout@v4\n")

    def test_accepts_reviewed_runtime_toolchain_pins(self) -> None:
        workflow = (
            "steps:\n"
            "  - uses: oven-sh/setup-bun@"
            "0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
            "    with:\n"
            '      bun-version: "1.3.14"\n'
            "  - uses: actions/setup-python@"
            "ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0\n"
            "    with:\n"
            '      python-version: "3.14.6"\n'
            "  - uses: astral-sh/setup-uv@"
            "f98e06938123ccabd21905ea5d0069192241f9f1 # v8.3.2\n"
            "    with:\n"
            '      version: "0.11.29"\n'
        )
        VERIFIER.verify_actions("fixture.yml", workflow)

    def test_rejects_previous_runtime_toolchain_pins(self) -> None:
        workflow = (
            "steps:\n"
            "  - uses: oven-sh/setup-bun@"
            "0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
            "    with:\n"
            '      bun-version: "1.2.19"\n'
            "  - uses: actions/setup-python@"
            "ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0\n"
            "    with:\n"
            '      python-version: "3.12.13"\n'
            "  - uses: astral-sh/setup-uv@"
            "f98e06938123ccabd21905ea5d0069192241f9f1 # v8.3.2\n"
            "    with:\n"
            '      version: "0.8.22"\n'
        )
        self.assert_rejected(workflow)

    def test_rejects_job_permission_escalation_under_read_only_default(self) -> None:
        workflow = (
            "permissions:\n"
            "  contents: read\n"
            "jobs:\n"
            "  test:\n"
            "    permissions:\n"
            "      contents: write\n"
        )
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                VERIFIER.verify_read_only_permissions("fixture.yml", workflow)


class WorkflowPermissionTests(unittest.TestCase):
    def test_accepts_reviewed_inventory_artifact_read_permissions(self) -> None:
        workflow = (
            "permissions:\n"
            "  actions: read\n"
            "  contents: read\n"
            "\n"
            "jobs:\n"
            "  inventory:\n"
            "    runs-on: ubuntu-latest\n"
        )
        VERIFIER.verify_read_only_permissions(
            ".github/workflows/prelive-destructive-inventory.yml", workflow
        )

    def test_rejects_unreviewed_inventory_artifact_permissions(self) -> None:
        workflow = (
            "permissions:\n"
            "  contents: read\n"
            "\n"
            "jobs:\n"
            "  inventory:\n"
            "    runs-on: ubuntu-latest\n"
        )
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                VERIFIER.verify_read_only_permissions(
                    ".github/workflows/prelive-destructive-inventory.yml", workflow
                )

    def test_rejects_job_level_escalation_in_read_only_workflow(self) -> None:
        workflow = (
            "permissions:\n"
            "  contents: read\n"
            "\n"
            "jobs:\n"
            "  test:\n"
            "    permissions:\n"
            "      contents: write\n"
            "    runs-on: ubuntu-latest\n"
        )
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                VERIFIER.verify_read_only_permissions("fixture.yml", workflow)

    def test_accepts_job_level_read_only_narrowing(self) -> None:
        workflow = (
            "permissions:\n"
            "  contents: read\n"
            "\n"
            "jobs:\n"
            "  test:\n"
            "    permissions: {}\n"
            "    runs-on: ubuntu-latest\n"
        )
        VERIFIER.verify_read_only_permissions("fixture.yml", workflow)


class WorkflowRunExpressionTests(unittest.TestCase):
    def assert_rejected(self, workflow: str) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                VERIFIER.verify_untrusted_expressions_are_environment_bound(
                    "fixture.yml", workflow
                )

    def test_rejects_direct_expression_in_mapping_style_run(self) -> None:
        self.assert_rejected(
            "steps:\n"
            "  - name: unsafe\n"
            "    run: echo '${{ inputs.value }}'\n"
        )

    def test_rejects_direct_expression_in_compact_sequence_run(self) -> None:
        self.assert_rejected(
            "steps:\n"
            "  - run: echo '${{ github.event.pull_request.title }}'\n"
        )

    def test_rejects_direct_expression_in_flow_style_run(self) -> None:
        self.assert_rejected(
            "steps:\n"
            "  - { run: \"echo '${{ github.head_ref }}'\", shell: bash }\n"
        )

    def test_accepts_environment_bound_expression(self) -> None:
        VERIFIER.verify_untrusted_expressions_are_environment_bound(
            "fixture.yml",
            "steps:\n"
            "  - run: echo \"$VALUE\"\n"
            "    env:\n"
            "      VALUE: ${{ inputs.value }}\n",
        )


if __name__ == "__main__":
    unittest.main()
