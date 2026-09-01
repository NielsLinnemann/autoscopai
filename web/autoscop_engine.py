"""
AutoscopAI review engine — runs inside Pyodide (CPython compiled to WebAssembly)
in a Web Worker. HTTP calls go through pyodide.http.pyfetch (no local OS
process to route through), and PDF/text extraction works on in-memory bytes
instead of file paths. Concurrency (running a stage's agents in parallel) is
orchestrated from worker.js via asyncio, one call per agent, so JS can report
per-agent progress as each one finishes.
"""
import base64
import io
import json
import textwrap

from pyodide.http import pyfetch


def read_pdf_bytes(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"\n\n--- PDF page {index} ---\n\n{text.strip()}")
    extracted = "\n".join(pages).strip()
    if not extracted:
        raise RuntimeError("No extractable text found in this PDF.")
    return extracted


def extract_text(filename: str, data: bytes) -> str:
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if suffix == "pdf":
        return read_pdf_bytes(data)
    return data.decode("utf-8", errors="replace")


async def chat_completion(base_url, api_key, model, messages, temperature, max_tokens, reasoning_effort=None, http_referer=None, app_title=None):
    if not api_key:
        raise RuntimeError("No API key is set. Add one in Settings.")
    if not model:
        raise RuntimeError("No model configured for this agent.")

    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if reasoning_effort and reasoning_effort != "default":
        payload["reasoning_effort"] = reasoning_effort

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if http_referer:
        headers["HTTP-Referer"] = http_referer
    if app_title:
        headers["X-OpenRouter-Title"] = app_title

    response = await pyfetch(url, method="POST", headers=headers, body=json.dumps(payload))
    if not response.ok:
        body = await response.string()
        raise RuntimeError(f"Router request failed with HTTP {response.status}: {body[:2000]}")

    data = await response.json()
    data = data.to_py() if hasattr(data, "to_py") else data

    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError(f"Unexpected router response: {json.dumps(data)[:2000]}") from error

    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if text:
                    parts.append(str(text))
            elif item:
                parts.append(str(item))
        joined = "\n".join(parts).strip()
        if joined:
            return joined

    reasoning = message.get("reasoning")
    if isinstance(reasoning, str) and reasoning.strip():
        raise RuntimeError(f"Model {model} returned reasoning but no final answer. Try a larger token budget or a different model.")

    finish_reason = data["choices"][0].get("finish_reason")
    raise RuntimeError(f"Model {model} returned no text content. finish_reason={finish_reason}")


def model_attempts(agent, default_model):
    attempts = []
    for model in [agent.get("model"), *agent.get("model_candidates", []), default_model]:
        if model and model not in attempts:
            attempts.append(model)
    return attempts


async def call_with_model_fallback(agent, messages, api, max_tokens):
    errors = []
    attempts = model_attempts(agent, api.get("default_model", ""))
    if not attempts:
        raise RuntimeError(f"No model configured for {agent['name']}.")

    for model in attempts:
        try:
            content = await chat_completion(
                base_url=api["base_url"],
                api_key=api["api_key"],
                model=model,
                messages=messages,
                temperature=agent.get("temperature", 0.2),
                max_tokens=max_tokens,
                reasoning_effort=agent.get("reasoning_effort"),
                http_referer=api.get("http_referer"),
                app_title=api.get("app_title"),
            )
            return model, content
        except Exception as error:  # noqa: BLE001 - fall through to next candidate
            errors.append(f"{model}: {error}")

    raise RuntimeError(f"All model attempts failed for {agent['name']}:\n- " + "\n- ".join(errors))


# ---------------------------------------------------------------------------
# Prompt builders — ported 1:1 from review.py / dialect_review.py.
# ---------------------------------------------------------------------------

def reviewer_system_prompt(reviewer):
    extra = (reviewer.get("extra_instructions") or "").strip()
    extra_section = f"\n\nAdditional instructions:\n{extra}" if extra else ""
    return textwrap.dedent(f"""
        You are the {reviewer["name"]} in a multi-agent academic article review panel.

        Your remit is: {reviewer["focus"]}.{extra_section}

        Review independently. Be precise, constructive, and intellectually serious.
        Separate major issues from minor issues. Do not pad the report with generic advice.
        Quote only short snippets when necessary, and keep quotations brief.

        Output exactly these sections:
        # Overall Assessment
        # Major Issues
        # Minor Issues
        # Section-Level Comments
        # Revision Suggestions
        """).strip()


def reviewer_user_prompt(article_text, context, bibliography_text=""):
    bibliography_section = f"\n\nBibliography file(s):\n{bibliography_text}" if bibliography_text else ""
    return textwrap.dedent(f"""
        Context for the review:
        {context or "No extra venue, audience, or disciplinary context was provided."}

        Article:
        {article_text}{bibliography_section}
        """).strip()


async def run_reviewer(reviewer, article_text, context, api, bibliography_text=""):
    messages = [
        {"role": "system", "content": reviewer_system_prompt(reviewer)},
        {"role": "user", "content": reviewer_user_prompt(article_text, context, bibliography_text)},
    ]
    model, content = await call_with_model_fallback(reviewer, messages, api, api["reviewer_max_tokens"])
    return {"id": reviewer["id"], "name": reviewer["name"], "model": model, "content": content}


def synthesis_prompt(article_text, context, reports, bibliography_text=""):
    joined_reports = "\n\n".join(f"## {r['name']} ({r['model']})\n\n{r['content']}" for r in reports)
    bibliography_section = f"\n\nBibliography file(s):\n{bibliography_text}" if bibliography_text else ""
    return textwrap.dedent(f"""
        You are the lead editor synthesizing a multi-agent academic article review.

        Produce one coherent author-facing report. Remove duplicates, preserve genuine
        disagreements when they matter, and rank issues by importance. Do not invent
        unsupported criticisms. You may add editorial judgment when it follows from the
        reports and article.

        Context:
        {context or "No extra venue, audience, or disciplinary context was provided."}

        Required output:
        # Overall Assessment
        # Top Revision Priorities
        # Major Comments
        # Minor Comments
        # Suggested Revision Plan
        # Reviewer Disagreements or Uncertainties

        Article:
        {article_text}{bibliography_section}

        Independent reviewer reports:
        {joined_reports}
        """).strip()


async def run_synthesis(lead_editor, article_text, context, reports, api, bibliography_text=""):
    messages = [
        {"role": "system", "content": "You are a rigorous, fair, and concise lead editor for academic article reviews."},
        {"role": "user", "content": synthesis_prompt(article_text, context, reports, bibliography_text)},
    ]
    model, content = await call_with_model_fallback(lead_editor, messages, api, api["synthesis_max_tokens"])
    return model, content


def respondent_system_prompt(agent):
    extra = (agent.get("extra_instructions") or "").strip()
    extra_section = f"\n\nAdditional instructions:\n{extra}" if extra else ""
    return textwrap.dedent(f"""
        You are the {agent["name"]} in a dialectical review of an academic article.

        Your stance:
        {agent["stance"]}{extra_section}

        You are not a cheerleader. Defend the paper where the criticism is unfair, but concede
        real problems clearly. Treat the first-round reviews as objections to be tested, not as
        authoritative verdicts.

        For each important first-round complaint you discuss, classify it as one of:
        - Accept
        - Partially accept
        - Downgrade
        - Reject
        - Needs clarification

        Output exactly these sections:
        # Overall Dialectical Assessment
        # Complaints to Accept
        # Complaints to Partially Accept
        # Complaints to Downgrade or Reject
        # Best Author Response
        # Residual Revision Priorities
        """).strip()


def respondent_user_prompt(article_text, bibliography_text, first_individual, first_synthesis, context):
    bibliography_section = f"\n\nBibliography file(s):\n{bibliography_text}" if bibliography_text else ""
    return textwrap.dedent(f"""
        Context:
        {context or "No extra venue, audience, or disciplinary context was provided."}

        Original article:
        {article_text}{bibliography_section}

        First-round individual reviewer reports:
        {first_individual}

        First-round lead-editor synthesis:
        {first_synthesis}
        """).strip()


async def run_respondent(agent, article_text, bibliography_text, first_individual, first_synthesis, context, api, max_tokens):
    messages = [
        {"role": "system", "content": respondent_system_prompt(agent)},
        {"role": "user", "content": respondent_user_prompt(article_text, bibliography_text, first_individual, first_synthesis, context)},
    ]
    model, content = await call_with_model_fallback(agent, messages, api, max_tokens)
    return {"id": agent["id"], "name": agent["name"], "model": model, "content": content}


def editor_prompt(article_text, bibliography_text, first_individual, first_synthesis, dialectical_responses, context):
    bibliography_section = f"\n\nBibliography file(s):\n{bibliography_text}" if bibliography_text else ""
    return textwrap.dedent(f"""
        You are the Dialectical Editor. You must adjudicate a two-stage review of an academic
        article.

        Your task is to decide what the author should actually take from the initial reviews after
        considering the dialectical respondent agents. Do not simply average the agents. Give a
        reasoned verdict.

        Context:
        {context or "No extra venue, audience, or disciplinary context was provided."}

        Original article:
        {article_text}{bibliography_section}

        First-round individual reviewer reports:
        {first_individual}

        First-round lead-editor synthesis:
        {first_synthesis}

        Dialectical respondent reports:
        {dialectical_responses}

        Output exactly these sections:
        # Final Verdict
        # Initial Review Complaints to Accept
        # Initial Review Complaints to Partially Accept
        # Initial Review Complaints to Downgrade or Reject
        # Misreadings or Overreach in the Initial Reviews
        # Author's Best Revision Strategy
        # Priority Table
        """).strip()


async def run_dialectical_editor(editor, article_text, bibliography_text, first_individual, first_synthesis, dialectical_responses, context, api, max_tokens):
    messages = [
        {"role": "system", "content": "You are a rigorous meta-review editor adjudicating reviewer objections and author-side replies."},
        {"role": "user", "content": editor_prompt(article_text, bibliography_text, first_individual, first_synthesis, dialectical_responses, context)},
    ]
    model, content = await call_with_model_fallback(editor, messages, api, max_tokens)
    return model, content


def learning_teacher_prompt(article_text, first_individual, first_synthesis, dialectical_responses, verdict, context):
    return textwrap.dedent(f"""
        You are the Learning Teacher for an academic writer. Extract durable lessons from this
        review process. Focus on reusable habits the author can improve in future drafts, not
        one-off fixes for this paper only.

        Context:
        {context or "No extra venue, audience, or disciplinary context was provided."}

        Original article:
        {article_text}

        First-round individual reviewer reports:
        {first_individual}

        First-round lead-editor synthesis:
        {first_synthesis}

        Dialectical respondent reports:
        {dialectical_responses}

        Final dialectical editor verdict:
        {verdict}

        Output exactly these sections:
        # Common Learnings
        - 6 to 10 concise bullet points

        # Patterns Behind The Learnings
        # Next Draft Checklist
        """).strip()


async def run_learning_teacher(teacher, article_text, first_individual, first_synthesis, dialectical_responses, verdict, context, api, max_tokens):
    messages = [
        {"role": "system", "content": teacher.get("focus") or "Extract reusable writing lessons from academic review feedback."},
        {"role": "user", "content": learning_teacher_prompt(article_text, first_individual, first_synthesis, dialectical_responses, verdict, context)},
    ]
    model, content = await call_with_model_fallback(teacher, messages, api, max_tokens)
    return model, content


def combined_agent_reports(title, reports):
    lines = [f"# {title}", ""]
    for report in reports:
        lines.extend([f"# {report['name']}", "", f"- model: {report['model']}", "", report["content"].rstrip(), ""])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# JSON-boundary wrappers. worker.js only ever calls these two functions, with
# plain strings in and out, to sidestep PyProxy/typed-array marshalling.
# ---------------------------------------------------------------------------

def extract_text_json(filename, base64_data):
    text = extract_text(filename, base64.b64decode(base64_data))
    return json.dumps({"text": text})


async def run_stage_call_json(kind, payload_json):
    payload = json.loads(payload_json)
    api = payload["api"]
    context = payload.get("context", "")
    bibliography_text = payload.get("bibliography_text", "")

    if kind == "reviewer":
        result = await run_reviewer(payload["agent"], payload["article_text"], context, api, bibliography_text)
        return json.dumps({"report": result})

    if kind == "synthesis":
        model, content = await run_synthesis(payload["agent"], payload["article_text"], context, payload["reports"], api, bibliography_text)
        return json.dumps({"model": model, "content": content})

    if kind == "respondent":
        result = await run_respondent(
            payload["agent"], payload["article_text"], bibliography_text,
            payload["first_individual"], payload["first_synthesis"], context, api, payload["max_tokens"],
        )
        return json.dumps({"report": result})

    if kind == "editor":
        model, content = await run_dialectical_editor(
            payload["agent"], payload["article_text"], bibliography_text,
            payload["first_individual"], payload["first_synthesis"], payload["dialectical_responses"],
            context, api, payload["max_tokens"],
        )
        return json.dumps({"model": model, "content": content})

    if kind == "learning_teacher":
        model, content = await run_learning_teacher(
            payload["agent"], payload["article_text"], payload["first_individual"], payload["first_synthesis"],
            payload["dialectical_responses"], payload["verdict"], context, api, payload["max_tokens"],
        )
        return json.dumps({"model": model, "content": content})

    raise RuntimeError(f"Unknown stage call kind: {kind}")
