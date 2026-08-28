import json
import sys
import urllib.request
import urllib.error


TARGET_WORKFLOW_ID = "3Fj5HTz7S7ux1ekd"
TARGET_NUMBER = "573227329097"


def api_request(method: str, url: str, api_key: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"X-N8N-API-KEY": api_key}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: update_8am_workflow_to_manual_chat.py <n8n_base_url> <n8n_api_key>", file=sys.stderr)
        return 2

    base_url = sys.argv[1].rstrip("/")
    api_key = sys.argv[2]

    workflow = api_request("GET", f"{base_url}/workflows/{TARGET_WORKFLOW_ID}", api_key)

    nodes = workflow["nodes"]
    for node in nodes:
        if node["id"] == "prepare-status-items":
            node["name"] = "Preparar imagenes para envio"
            node["parameters"]["jsCode"] = (
                "const source = $input.first().json || {};\n"
                "const generatedFiles = Array.isArray(source.generated_files) ? source.generated_files : [];\n\n"
                "if (!generatedFiles.length) {\n"
                "  return [{ json: { should_send: false, status: 'no_generated_files', generated_count: 0 } }];\n"
                "}\n\n"
                "return generatedFiles.map((file, index) => ({\n"
                "  json: {\n"
                "    should_send: true,\n"
                "    status: 'ready_to_send',\n"
                "    generated_count: generatedFiles.length,\n"
                "    send_index: index + 1,\n"
                f"    number: '{TARGET_NUMBER}',\n"
                "    media: file.public_url || file.internal_url,\n"
                "    caption: '',\n"
                "    file_name: file.delivery_file_name || file.file_name || `status_${String(index + 1).padStart(2, '0')}.jpg`,\n"
                "    product_name: file.product?.nombre || '',\n"
                "  }\n"
                "}));"
            )
        elif node["id"] == "should-publish":
            node["name"] = "¿Hay imagenes para enviar?"
            node["parameters"]["conditions"]["conditions"][0]["leftValue"] = "={{ $json.should_send }}"
        elif node["id"] == "publish-status":
            node["name"] = "Enviar imagen al 3227329097"
            node["parameters"]["url"] = "http://evolution_api:8080/message/sendMedia/alumas"
            node["parameters"]["bodyParameters"]["parameters"] = [
                {"name": "number", "value": "={{ $json.number }}"},
                {"name": "mediatype", "value": "image"},
                {"name": "media", "value": "={{ $json.media }}"},
                {"name": "fileName", "value": "={{ $json.file_name }}"},
                {"name": "caption", "value": "={{ $json.caption }}"},
            ]
            node["parameters"]["options"]["batching"]["batch"]["batchSize"] = 1
            node["parameters"]["options"]["batching"]["batch"]["batchInterval"] = 2000
            node["parameters"]["options"]["response"]["response"]["neverError"] = False
        elif node["id"] == "no-statuses":
            node["name"] = "Sin imagenes generadas"
            node["parameters"]["jsonOutput"] = "={\n  \"status\": $json.status,\n  \"generated_count\": $json.generated_count\n}"

    workflow["connections"] = {
        "Schedule Trigger 8AM": workflow["connections"]["Schedule Trigger 8AM"],
        "Generar 15 estados": {
            "main": [[{"node": "Preparar imagenes para envio", "type": "main", "index": 0}]]
        },
        "Preparar imagenes para envio": {
            "main": [[{"node": "¿Hay imagenes para enviar?", "type": "main", "index": 0}]]
        },
        "¿Hay imagenes para enviar?": {
            "main": [
                [{"node": "Enviar imagen al 3227329097", "type": "main", "index": 0}],
                [{"node": "Sin imagenes generadas", "type": "main", "index": 0}],
            ]
        },
    }

    payload = {
        "name": workflow["name"],
        "nodes": nodes,
        "connections": workflow["connections"],
        "settings": workflow.get("settings") or {},
        "staticData": workflow.get("staticData"),
        "pinData": workflow.get("pinData"),
    }

    updated = api_request("PUT", f"{base_url}/workflows/{TARGET_WORKFLOW_ID}", api_key, payload)
    print(json.dumps({
        "id": updated["id"],
        "name": updated["name"],
        "active": updated["active"],
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
