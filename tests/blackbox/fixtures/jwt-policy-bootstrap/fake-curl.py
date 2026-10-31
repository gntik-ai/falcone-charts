#!/usr/bin/env python3
"""Offline Keycloak boundary for the published bootstrap program; no sockets."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
root = Path(os.environ["JWT_BOOTSTRAP_TEST_DIR"])
scenario = os.environ["JWT_BOOTSTRAP_TEST_SCENARIO"]


def option(name):
    return args[args.index(name) + 1] if name in args else None


url = next(arg for arg in reversed(args) if arg.startswith("http"))
method = option("-X") or "GET"
output = option("-o")
data = option("--data")
calls_file = root / "calls.json"
calls = json.loads(calls_file.read_text()) if calls_file.exists() else []
calls.append({"method": method, "url": url})
calls_file.write_text(json.dumps(calls))
state_file = root / "state.json"
mapper = {"id": "mapper-id", "name": "in-falcone-audience", "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
          "config": {"included.custom.audience": "in-falcone", "access.token.claim": "true", "id.token.claim": "false"}}
state = json.loads(state_file.read_text()) if state_file.exists() else {"mapper": (
    None if scenario in ("missing", "write-failure", "readback-drift") else
    {**mapper, "config": {}} if scenario == "drift" else mapper)}
body = ""
status = 200
if url.endswith("/protocol/openid-connect/token"):
    body = '{"access_token":"offline-fixture"}'
elif "/protocol-mappers/models" in url:
    if method == "GET":
        actual = state["mapper"]
        if actual and scenario == "provider-metadata":
            actual = {**actual, "consentText": None}
        if actual and scenario == "readback-drift":
            actual = {**actual, "config": {}}
        body = json.dumps([actual] if actual else [])
    else:
        if scenario == "write-failure":
            status, body = 503, 'private-provider-response-must-not-escape'
        else:
            state["mapper"] = {**json.loads(Path(data[1:]).read_text()), "id": "mapper-id"}
            status = 201 if method == "POST" else 204
elif "/clients?clientId=" in url:
    client_id = url.split("clientId=", 1)[1]
    body = json.dumps([{"id": "client-id", "clientId": client_id}], separators=(",", ":"))
elif "/users?username=" in url:
    body = '[{"id":"user-id","username":"superadmin"}]'
elif url.endswith("/admin/realms/in-falcone-platform"):
    if method == "PUT":
        status = 204
    elif output and output.endswith("keycloak-login-readback"):
        body = (root / "payload/login.json").read_text()
    else:
        body = '{"realm":"in-falcone-platform"}'
else:
    sys.exit("unsupported fixture request")
state_file.write_text(json.dumps(state))
if output:
    Path(output).write_text(body)
elif body:
    print(body, end="")
if "-w" in args:
    print(status, end="")
