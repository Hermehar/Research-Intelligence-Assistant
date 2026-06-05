from app.services.llm.summarizer import _confidence, _parse_json

def test_confidence_bounds():
    assert _confidence(0.0, 0.0, 0.0) == 0.0
    assert _confidence(1.0, 1.0, 1.0) == 1.0

def test_confidence_weighting():
    score = _confidence(1.0, 0.0, 0.0)
    assert score == 0.4

def test_parse_plain_json():
    out = _parse_json('{"research_problem": "x", "dataset": ""}')
    assert out["research_problem"] == "x"

def test_parse_fenced_json():
    raw = "```json\n{\"motivation\": \"because\"}\n```"
    out = _parse_json(raw)
    assert out["motivation"] == "because"

def test_parse_json_with_prose_around():
    raw = "Here is the summary:\n{\"key_results\": \"good\"}\nThanks!"
    out = _parse_json(raw)
    assert out["key_results"] == "good"
