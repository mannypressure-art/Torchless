#!/usr/bin/env python3
"""Checks one port's bench output against scenarios.json.
usage: python3 check-parity.py <bench output file>
The output must hold one 'PASS <title>' line per scenario, with titles exactly as in scenarios.json."""
import json, os, sys
spec = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenarios.json")))
titles = [s["title"] for s in spec["scenarios"]]
lines = open(sys.argv[1]).read().splitlines()
passed = {l[5:].strip() for l in lines if l.startswith("PASS ")}
failed = [l for l in lines if l.startswith("FAIL ")]
missing = [t for t in titles if t not in passed]
extra = sorted(passed - set(titles))
for t in missing: print("MISSING or FAILED:", t)
for l in failed: print(l)
for t in extra: print("NOT IN SPEC:", t)
ok = not missing and not extra and not failed
print(f"{len(titles) - len(missing)} of {len(titles)} shared scenarios passed" + ("" if ok else " (NOT OK)"))
sys.exit(0 if ok else 1)
