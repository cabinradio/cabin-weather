"""Validate the JSON the front end reads against pipeline/schemas/*.json.

A deliberately small JSON Schema subset, written here so the pipeline stays
stdlib + requests. Supported keywords: type (incl. lists), properties,
required, additionalProperties (bool or schema), items, minItems, maxItems,
minProperties, maxProperties, enum, const, minimum, maximum, minLength,
pattern, anyOf, $ref (to #/$defs/...). Anything else in a schema is ignored,
so keep the schemas inside this subset.

Usage:
    python pipeline/validate.py                 # validate everything under data/
    python pipeline/validate.py data/current.json data/history/yellowknife.json

Exits 1 on the first file with problems (after reporting all of them). A
validation failure in CI fails the job, so the previous deploy stays up.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = Path(__file__).resolve().parent / "schemas"
DATA = ROOT / "data"

SIZE_TARGETS = {"current": 40_000, "forecast": 20_000, "history": 60_000}

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer()),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _resolve(ref: str, root: dict) -> dict:
    if not ref.startswith("#/"):
        raise ValueError(f"only local $ref is supported: {ref}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def validate(instance, schema: dict, root: dict | None = None, path: str = "$") -> list[str]:
    """Return a list of problems ('' means valid). Reports every problem, not just the first."""
    root = root if root is not None else schema
    if "$ref" in schema:
        return validate(instance, _resolve(schema["$ref"], root), root, path)

    errors: list[str] = []

    if "anyOf" in schema:
        branches = [validate(instance, s, root, path) for s in schema["anyOf"]]
        if not any(b == [] for b in branches):
            errors.append(f"{path}: matches none of the allowed forms ({'; '.join(e[0] for e in branches if e)})")
            return errors

    if "type" in schema:
        allowed = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_TYPE_CHECKS[t](instance) for t in allowed):
            errors.append(f"{path}: expected {' or '.join(allowed)}, got {type(instance).__name__}")
            return errors

    if isinstance(instance, float) and (math.isnan(instance) or math.isinf(instance)):
        errors.append(f"{path}: NaN or infinity is not allowed")

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: must be {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of {schema['enum']!r}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} is below the minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} is above the maximum {schema['maximum']}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: string shorter than {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{path}: {instance!r} does not match {schema['pattern']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(instance):
                errors += validate(item, schema["items"], root, f"{path}[{i}]")

    if isinstance(instance, dict):
        if "minProperties" in schema and len(instance) < schema["minProperties"]:
            errors.append(f"{path}: fewer than {schema['minProperties']} entries")
        if "maxProperties" in schema and len(instance) > schema["maxProperties"]:
            errors.append(f"{path}: more than {schema['maxProperties']} entries")
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing required key {key!r}")
        props = schema.get("properties", {})
        for key, value in instance.items():
            if key in props:
                errors += validate(value, props[key], root, f"{path}.{key}")
            else:
                extra = schema.get("additionalProperties", True)
                if extra is False:
                    errors.append(f"{path}: unexpected key {key!r}")
                elif isinstance(extra, dict):
                    errors += validate(value, extra, root, f"{path}.{key}")
    return errors


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / f"{name}.json").read_text("utf-8"))


def schema_for(path: Path) -> str | None:
    """current.json -> current; anything in a forecast/ or history/ folder -> that schema (also outside data/)."""
    if path.name == "current.json":
        return "current"
    if path.parent.name == "forecast":
        return "forecast"
    if path.parent.name == "history":
        return "history"
    return None


def expected_slugs() -> set[str]:
    cfg = json.loads((Path(__file__).resolve().parent / "config" / "communities.json").read_text("utf-8"))
    return {c["slug"] for c in cfg["communities"]}


def check_file(path: Path) -> list[str]:
    kind = schema_for(path)
    if kind is None:
        return [f"{path}: no schema applies to this path"]
    try:
        instance = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        return [f"{path}: cannot read as JSON ({exc})"]
    problems = validate(instance, load_schema(kind))
    if kind == "current" and isinstance(instance, dict) and isinstance(instance.get("communities"), dict):
        got = set(instance["communities"])
        want = expected_slugs()
        if got != want:
            problems.append(f"$.communities: slugs differ from config (missing {sorted(want - got)}, extra {sorted(got - want)})")
    if kind in ("forecast", "history") and isinstance(instance, dict) and instance.get("slug") != path.stem:
        problems.append(f"$.slug: {instance.get('slug')!r} does not match the file name {path.stem!r}")
    size = path.stat().st_size
    if size > SIZE_TARGETS[kind]:
        problems.append(f"{path}: {size:,} bytes is over the {SIZE_TARGETS[kind]:,}-byte target")
    return [f"{path.name}: {p}" if not p.startswith(str(path)) else p for p in problems]


def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv] or sorted(
        [p for p in [DATA / "current.json"] if p.exists()]
        + sorted((DATA / "forecast").glob("*.json"))
        + sorted((DATA / "history").glob("*.json"))
    )
    if not paths:
        print("validate: nothing to validate")
        return 0
    failed = 0
    for path in paths:
        problems = check_file(path)
        if problems:
            failed += 1
            print(f"FAIL {path}")
            for p in problems[:50]:
                print("   ", p)
            if len(problems) > 50:
                print(f"    ... and {len(problems) - 50} more")
        else:
            print(f"ok   {path} ({path.stat().st_size:,} bytes)")
    print(f"validate: {len(paths) - failed} ok, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
