#!/usr/bin/env python3
"""Offline Keycloak boundary for the published bootstrap program; no sockets."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
root = Path(os.environ["JWT_BOOTSTRAP_TEST_DIR"])
scenario = os.environ["JWT_BOOTSTRAP_TEST_SCENARIO"]
scenario = {"readback-invalid-shape": "readback-object",
            "readback-missing-key": "readback-missing-key:included.custom.audience"}.get(scenario, scenario)


def option(name):
    return args[args.index(name) + 1] if name in args else None


url = next(arg for arg in reversed(args) if arg.startswith("http"))
method = option("-X") or "GET"
output = option("-o")
data = option("--data")
calls_file = root / "calls.json"
calls = json.loads(calls_file.read_text()) if calls_file.exists() else []
call = {"method": method, "url": url}
if data and "/protocol-mappers/models" in url:
    call["payload"] = json.loads(Path(data[1:]).read_text())
calls.append(call)
calls_file.write_text(json.dumps(calls))
state_file = root / "state.json"
mapper = {"id": "mapper-id", "name": "in-falcone-audience", "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
          "config": {"included.custom.audience": "in-falcone", "access.token.claim": "true", "id.token.claim": "false"}}
initial = json.loads(json.dumps(mapper))
if scenario in ("missing", "write-failure", "write-transport", "readback-drift", "kc26-defaults"):
    initial = None
elif scenario == "drift":
    initial["config"] = {}
elif scenario == "wrong-audience":
    initial["config"]["included.custom.audience"] = "private-provider-response-must-not-escape"
elif scenario.startswith(("missing-key:", "wrong-key:")):
    key = scenario.split(":", 1)[1]
    if scenario.startswith("missing-key:"):
        initial["config"].pop(key)
    else:
        initial["config"][key] = "private-provider-response-must-not-escape"
state = json.loads(state_file.read_text()) if state_file.exists() else {"mapper": initial}
body = ""
status = 200
transport_error = False
if url.endswith("/protocol/openid-connect/token"):
    body = '{"access_token":"offline-fixture"}'
elif "/protocol-mappers/models" in url:
    if method == "GET":
        stage = "readback" if output.endswith("/readback") else "list"
        actual = json.loads(json.dumps(state["mapper"]))
        if actual:
            if scenario in ("converged-extras", "invalid-id-list", "invalid-id-readback-only"):
                actual["config"].update({"introspection.token.claim": "true", "lightweight.claim": "false"})
            if scenario in ("provider-metadata", "converged-extras"):
                actual["consentText"] = "private-provider-response-must-not-escape"
            if scenario == "readback-drift":
                actual["config"] = {}
            if scenario == "invalid-id-list" and stage == "list" or scenario == "invalid-id-readback-only" and stage == "readback":
                actual["id"] = "private-provider-response-must-not-escape/invalid"
            if scenario.startswith("readback-id:") and stage == "readback":
                actual["id"] = json.loads(scenario.split(":", 1)[1])
            if scenario.startswith(("readback-missing-key:", "readback-wrong-key:")) and stage == "readback":
                key = scenario.split(":", 1)[1]
                if scenario.startswith("readback-missing-key:"):
                    actual["config"].pop(key)
                else:
                    actual["config"][key] = "private-provider-response-must-not-escape"
            if scenario.startswith("readback-field:") and stage == "readback":
                actual.pop(scenario.split(":", 1)[1])
            if scenario == "readback-boolean" and stage == "readback":
                actual["config"]["access.token.claim"] = True
        body = json.dumps([actual] if actual else [])
        if scenario == "duplicate" or scenario == "readback-duplicate" and stage == "readback":
            body = json.dumps([actual, actual])
        if scenario == "readback-missing" and stage == "readback":
            body = '[]'
        shapes = {"empty-body": "", "string": json.dumps("private-provider-response-must-not-escape"),
                  "object": '{}', "number": '123', "multiple": '[]\n[]', "null": 'null',
                  "invalid-json": 'private-provider-response-must-not-escape offline-fixture in-falcone'}
        if scenario.startswith(stage + "-") and scenario[len(stage) + 1:] in shapes:
            body = shapes[scenario[len(stage) + 1:]]
        if scenario in (stage + "-failure", stage + "-transport"):
            status, body = 503, 'private-provider-response-must-not-escape'
            transport_error = scenario.endswith("transport")
    else:
        if scenario in ("write-failure", "write-transport"):
            status, body = 503, 'private-provider-response-must-not-escape'
            transport_error = scenario.endswith("transport")
        else:
            state["mapper"] = {**call["payload"], "id": "mapper-id"}
            if scenario == "kc26-defaults":
                state["mapper"]["config"].update({"introspection.token.claim": "true", "lightweight.claim": "false"})
            status = 201 if method == "POST" else 204
elif "/clients?clientId=" in url:
    client_id = url.split("clientId=", 1)[1]
    body = json.dumps([{"id": "client-id", "clientId": client_id}], separators=(",", ":"))
    if scenario.startswith("lookup-"):
        body = {"lookup-missing": '[]', "lookup-duplicate": body[:-1] + ',' + body[1:],
                "lookup-invalid-id": '[{"id":"unsafe/id","clientId":"in-falcone-console"}]',
                "lookup-multiple": body + '\n' + body, "lookup-object": '{}',
                "lookup-empty": '', "lookup-invalid-json": 'private-provider-response-must-not-escape'}.get(scenario, body)
        if scenario in ("lookup-failure", "lookup-transport"):
            status, body = 503, 'private-provider-response-must-not-escape'
            transport_error = scenario.endswith("transport")
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
    print("000" if transport_error else status, end="")
if transport_error:
    print("private-provider-response-must-not-escape offline-fixture in-falcone", file=sys.stderr)
    sys.exit(7)
