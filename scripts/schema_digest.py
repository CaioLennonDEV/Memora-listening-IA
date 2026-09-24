#!/usr/bin/env python3
"""Canonical JSON digest of the SQLAlchemy DB schema (tables + columns), from the model SOURCE —
no SQLAlchemy import, no database. stdlib ``ast`` only, so it runs on the CI runner with nothing
installed.

The authoritative schema is admin-api's models (it owns the tables; its ``ensure_schema`` creates
them) plus meeting-api's byte-faithful mirror. ``gate:db-schema`` diffs this digest against
``schema.seal.json``; ANY table/column add, drop, or change trips the gate and requires a deliberate
``pnpm seal:schema`` re-seal — a human review step. So the DB schema cannot drift silently and a
stray migration/model edit is caught in CI (the "no unreviewed database changes" rule, enforced).

Emits ``{ "<model-file>": { "<table>": { "<column>": "<normalized Column(...) source>" } } }`` with
tables and columns sorted, so only a real structural change moves the bytes (comments/formatting/
column-reordering do not).
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The schema-of-record + its mirror. Add a file here only when a NEW service owns real tables.
MODEL_FILES = [
    "core/identity/services/admin-api/src/admin_api/schema/models.py",
    "core/meetings/services/meeting-api/src/meeting_api/sessions/models.py",
]


def _is_column_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    name = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else "")
    return name in ("Column", "mapped_column")


def _tablename(cls: ast.ClassDef):
    for stmt in cls.body:
        targets = (
            stmt.targets if isinstance(stmt, ast.Assign)
            else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id == "__tablename__":
                if isinstance(stmt.value, ast.Constant):
                    return stmt.value.value
    return None


def _unparse(node: ast.AST) -> str:
    if hasattr(ast, "unparse"):
        return ast.unparse(node)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant):
        return repr(node.value)
    if isinstance(node, ast.Attribute):
        return f"{_unparse(node.value)}.{node.attr}"
    if isinstance(node, ast.Call):
        func = _unparse(node.func)
        args = [_unparse(a) for a in node.args]
        keywords = [f"{k.arg}={_unparse(k.value)}" for k in node.keywords]
        return f"{func}({', '.join(args + keywords)})"
    if isinstance(node, ast.Subscript):
        return f"{_unparse(node.value)}[{_unparse(node.slice)}]"
    if hasattr(ast, "Index") and isinstance(node, getattr(ast, "Index")):
        return _unparse(node.value)
    if isinstance(node, ast.Tuple):
        return f"({', '.join(_unparse(e) for e in node.elts)})"
    if isinstance(node, ast.List):
        return f"[{', '.join(_unparse(e) for e in node.elts)}]"
    if isinstance(node, ast.Dict):
        pairs = [f"{_unparse(k)}: {_unparse(v)}" for k, v in zip(node.keys, node.values)]
        return f"{{{', '.join(pairs)}}}"
    if isinstance(node, ast.Lambda):
        return "lambda: {}"
    if isinstance(node, ast.UnaryOp):
        op = "-" if isinstance(node.op, ast.USub) else "+"
        return f"{op}{_unparse(node.operand)}"
    return ""


def _columns(cls: ast.ClassDef) -> dict:
    cols: dict = {}
    for stmt in cls.body:
        target = value = None
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            target, value = stmt.targets[0].id, stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            target, value = stmt.target.id, stmt.value
        if target and _is_column_call(value):
            cols[target] = _unparse(value)  # normalized column definition (type + flags)
    return cols


def digest() -> dict:
    out: dict = {}
    for rel in MODEL_FILES:
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"), filename=rel)
        tables: dict = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                tn = _tablename(node)
                if tn:
                    tables[tn] = dict(sorted(_columns(node).items()))
        out[rel] = dict(sorted(tables.items()))
    return out


if __name__ == "__main__":
    print(json.dumps(digest(), indent=2, sort_keys=True))
