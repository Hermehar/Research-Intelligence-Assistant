from fastapi.testclient import TestClient

from app.main import app

def test_openapi_lists_expected_routes():
    client = TestClient(app)
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/api/v1/health" in paths
    assert "/api/v1/papers" in paths
    assert "/api/v1/papers/{paper_id}/pdf" in paths
    assert "/api/v1/analyze/summarize" in paths
    assert "/api/v1/runs/{run_id}" in paths
    assert "/api/v1/summaries/{paper_id}" in paths
