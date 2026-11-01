"""
PDF 逐句翻译 & AI 阅读助手 —— 后端
- 提供静态前端页面
- 代理调用任意 OpenAI 兼容接口（/chat/completions）
- 翻译结果缓存在 SQLite，重复打开同一文档无需重新翻译

运行：python server.py   然后浏览器打开 http://127.0.0.1:8000
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("PDFT_DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = DATA_DIR / "config.json"
DB_FILE = DATA_DIR / "cache.sqlite3"

# ---------------------------------------------------------------- 配置

DEFAULT_CONFIG: dict[str, Any] = {
    "base_url": os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    "api_key": os.environ.get("OPENAI_API_KEY", ""),
    "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    # 翻译可以单独指定一个更便宜/更快的模型，留空则使用 model
    "translate_model": os.environ.get("OPENAI_TRANSLATE_MODEL", ""),
    "target_lang": "简体中文",
    "temperature": 0.3,
    # 额外的翻译要求 / 术语表，例如 "transformer -> Transformer（不翻译）"
    "translate_instructions": "",
    "timeout": 180,
}

_config_lock = threading.Lock()


def load_config() -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.exists():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text("utf-8")))
        except Exception:
            pass
    return cfg


def save_config(cfg: dict[str, Any]) -> None:
    with _config_lock:
        CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 10:
        return "*" * len(key)
    return key[:4] + "*" * 6 + key[-4:]


# ---------------------------------------------------------------- 缓存

_db_lock = threading.Lock()
_db = sqlite3.connect(DB_FILE, check_same_thread=False)
_db.execute("CREATE TABLE IF NOT EXISTS tcache (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
_db.commit()


def cache_key(model: str, lang: str, instr: str, text: str) -> str:
    return hashlib.sha256(f"{model}\x00{lang}\x00{instr}\x00{text}".encode()).hexdigest()


def cache_get(keys: list[str]) -> dict[str, str]:
    if not keys:
        return {}
    out: dict[str, str] = {}
    with _db_lock:
        for i in range(0, len(keys), 500):
            chunk = keys[i : i + 500]
            q = "SELECT k, v FROM tcache WHERE k IN (%s)" % ",".join("?" * len(chunk))
            out.update(dict(_db.execute(q, chunk).fetchall()))
    return out


def cache_put(items: dict[str, str]) -> None:
    if not items:
        return
    with _db_lock:
        _db.executemany("INSERT OR REPLACE INTO tcache (k, v) VALUES (?, ?)", list(items.items()))
        _db.commit()


# ---------------------------------------------------------------- LLM 调用

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=20))
    return _client


def _endpoint(cfg: dict[str, Any], path: str) -> str:
    base = (cfg.get("base_url") or "").strip().rstrip("/")
    if not base:
        raise HTTPException(400, "未配置 API Base URL")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base + path


def _headers(cfg: dict[str, Any]) -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        h["Authorization"] = f"Bearer {cfg['api_key']}"
    return h


def _err_text(resp_text: str, status: int) -> str:
    try:
        j = json.loads(resp_text)
        msg = j.get("error", {}).get("message") if isinstance(j.get("error"), dict) else j.get("error")
        msg = msg or j.get("message") or resp_text
    except Exception:
        msg = resp_text
    return f"LLM 接口返回 {status}: {str(msg)[:500]}"


THINK_RE = re.compile(r"<think>.*?</think>", re.S)


async def chat_once(cfg: dict[str, Any], messages: list[dict], model: str, temperature: float) -> str:
    payload = {"model": model, "messages": messages, "temperature": temperature, "stream": False}
    try:
        r = await client().post(
            _endpoint(cfg, "/chat/completions"),
            headers=_headers(cfg),
            json=payload,
            timeout=float(cfg.get("timeout") or 180),
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"无法连接 LLM 接口: {e!r}")
    if r.status_code != 200:
        raise HTTPException(502, _err_text(r.text, r.status_code))
    try:
        content = r.json()["choices"][0]["message"].get("content") or ""
    except Exception:
        raise HTTPException(502, f"LLM 返回格式无法解析: {r.text[:300]}")
    return THINK_RE.sub("", content).strip()


# ---------------------------------------------------------------- 翻译

TRANSLATE_SYSTEM = """你是一名专业译者，擅长学术论文与技术文档翻译。请把用户给出的每个编号片段翻译成{lang}。

要求：
1. 忠实、准确、通顺，符合{lang}的表达习惯，不要漏译或增译。
2. 专业术语翻译准确，首次出现的关键术语可在括号内保留原文；人名、公式、变量、数字、引用标记（如 [12]、(Smith et al., 2020)）保持原样。
3. 片段由 PDF 自动抽取，可能含有断行、连字符或少量乱码，请根据上下文合理理解；页眉、页码、作者单位等也照常翻译或原样保留。
4. 每个编号片段独立输出一条译文，不要合并、拆分或调换顺序；即使片段很短或不完整，也要输出对应译文。
5. 只输出译文，不要任何解释。严格使用如下格式，每条译文以编号开头：
[[1]] 第一段译文
[[2]] 第二段译文
{extra}"""

ITEM_RE = re.compile(r"\[\[(\d+)\]\][ \t]*(.*?)(?=\n?\s*\[\[\d+\]\]|\Z)", re.S)


class Segment(BaseModel):
    id: int
    text: str


class TranslateReq(BaseModel):
    segments: list[Segment]
    context: str = ""          # 上文，仅供参考
    force: bool = False         # 忽略缓存，重新翻译
    instruction: str = ""       # 本次额外要求（重新翻译时使用）


async def _translate_batch(cfg: dict[str, Any], segs: list[Segment], context: str, instruction: str) -> dict[int, str]:
    lang = cfg.get("target_lang") or "简体中文"
    extra_parts = []
    if cfg.get("translate_instructions"):
        extra_parts.append("额外要求 / 术语表：\n" + cfg["translate_instructions"].strip())
    if instruction:
        extra_parts.append("本次翻译的特别要求：" + instruction.strip())
    extra = ("\n" + "\n\n".join(extra_parts)) if extra_parts else ""
    system = TRANSLATE_SYSTEM.format(lang=lang, extra=extra)

    body = []
    if context.strip():
        body.append("【上文，仅供理解语境，不要翻译】\n" + context.strip()[-1200:] + "\n")
    body.append("【待翻译片段】")
    for i, s in enumerate(segs, 1):
        body.append(f"[[{i}]] {s.text}")
    model = cfg.get("translate_model") or cfg.get("model")
    out = await chat_once(
        cfg,
        [{"role": "system", "content": system}, {"role": "user", "content": "\n".join(body)}],
        model,
        float(cfg.get("temperature") or 0.3),
    )
    result: dict[int, str] = {}
    for m in ITEM_RE.finditer(out):
        idx = int(m.group(1))
        if 1 <= idx <= len(segs):
            result[segs[idx - 1].id] = m.group(2).strip()
    # 只有一个片段且模型没按格式输出时，直接把整段当作译文
    if not result and len(segs) == 1 and out:
        result[segs[0].id] = out.strip()
    return result


app = FastAPI(title="PDF Translator")


@app.post("/api/translate")
async def translate(req: TranslateReq):
    cfg = load_config()
    lang = cfg.get("target_lang") or "简体中文"
    model = cfg.get("translate_model") or cfg.get("model")
    instr = (cfg.get("translate_instructions") or "") + "\x01" + req.instruction
    keys = {s.id: cache_key(model, lang, instr, s.text) for s in req.segments}

    found: dict[int, str] = {}
    if not req.force:
        cached = cache_get(list(keys.values()))
        for s in req.segments:
            if keys[s.id] in cached:
                found[s.id] = cached[keys[s.id]]
    todo = [s for s in req.segments if s.id not in found]
    n_cached = len(found)

    if todo:
        got = await _translate_batch(cfg, todo, req.context, req.instruction)
        missing = [s for s in todo if s.id not in got]
        # 模型偶尔漏条，对漏掉的片段再单独补译一次
        if missing:
            async def one(s: Segment):
                try:
                    return await _translate_batch(cfg, [s], req.context, req.instruction)
                except HTTPException:
                    return {}
            for part in await asyncio.gather(*(one(s) for s in missing[:20])):
                got.update(part)
        found.update(got)
        cache_put({keys[i]: t for i, t in got.items() if t})

    return {"translations": {str(k): v for k, v in found.items()}, "cached": n_cached}


# ---------------------------------------------------------------- 问答 / 润色（流式）

CHAT_SYSTEM = """你是一个专业、耐心的文档阅读与写作助手。用户正在阅读一份 PDF 文档（左侧原文，右侧{lang}译文），会选中其中的句子或段落向你提问，或请你解释、润色、提出修改意见。
- 默认使用{lang}回答；润色时保持被润色文本的原语言（英文就输出英文）。
- 回答准确、有条理，可以使用 Markdown（标题、列表、加粗、代码块）。
- 如果问题依赖文档中没有提供的信息，请明确说明，不要编造。"""


class ChatReq(BaseModel):
    messages: list[dict]
    doc_context: str = ""


@app.post("/api/chat")
async def chat(req: ChatReq):
    cfg = load_config()
    lang = cfg.get("target_lang") or "简体中文"
    system = CHAT_SYSTEM.format(lang=lang)
    if req.doc_context.strip():
        system += "\n\n以下是文档的部分内容，供参考：\n<document>\n" + req.doc_context.strip()[:6000] + "\n</document>"
    msgs = [{"role": "system", "content": system}]
    for m in req.messages[-16:]:
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            msgs.append({"role": m["role"], "content": m["content"]})

    payload = {
        "model": cfg.get("model"),
        "messages": msgs,
        "temperature": float(cfg.get("temperature") or 0.3),
        "stream": True,
    }

    async def gen():
        def ev(**kw):
            return (json.dumps(kw, ensure_ascii=False) + "\n").encode()

        try:
            url, headers = _endpoint(cfg, "/chat/completions"), _headers(cfg)
        except HTTPException as e:
            yield ev(t="error", m=e.detail)
            return
        try:
            async with client().stream("POST", url, headers=headers, json=payload,
                                       timeout=float(cfg.get("timeout") or 180)) as r:
                if r.status_code != 200:
                    text = (await r.aread()).decode("utf-8", "replace")
                    yield ev(t="error", m=_err_text(text, r.status_code))
                    return
                ctype = r.headers.get("content-type", "")
                if "text/event-stream" not in ctype and "json" in ctype:
                    # 某些兼容服务忽略 stream 参数，直接返回完整 JSON
                    j = json.loads(await r.aread())
                    yield ev(t="delta", c=j["choices"][0]["message"].get("content") or "")
                    yield ev(t="done")
                    return
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        j = json.loads(data)
                    except Exception:
                        continue
                    if j.get("error"):
                        yield ev(t="error", m=str(j["error"])[:500])
                        return
                    for ch in j.get("choices") or []:
                        d = ch.get("delta") or {}
                        rc = d.get("reasoning_content") or d.get("reasoning")
                        if rc:
                            yield ev(t="reasoning", c=rc)
                        if d.get("content"):
                            yield ev(t="delta", c=d["content"])
            yield ev(t="done")
        except httpx.HTTPError as e:
            yield ev(t="error", m=f"无法连接 LLM 接口: {e!r}")

    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- 设置

class ConfigReq(BaseModel):
    base_url: str | None = None
    api_key: str | None = None   # 为空 / None 表示保持不变
    model: str | None = None
    translate_model: str | None = None
    target_lang: str | None = None
    temperature: float | None = None
    translate_instructions: str | None = None
    timeout: float | None = None


def public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    c = dict(cfg)
    c["has_key"] = bool(c.get("api_key"))
    c["api_key"] = mask_key(c.get("api_key", ""))
    return c


@app.get("/api/config")
async def get_config():
    return public_config(load_config())


@app.post("/api/config")
async def set_config(req: ConfigReq):
    cfg = load_config()
    for k, v in req.model_dump().items():
        if v is None:
            continue
        if k == "api_key" and (v == "" or v == mask_key(cfg.get("api_key", ""))):
            continue
        cfg[k] = v.strip() if isinstance(v, str) and k != "translate_instructions" else v
    save_config(cfg)
    return public_config(cfg)


@app.post("/api/config/clear_key")
async def clear_key():
    cfg = load_config()
    cfg["api_key"] = ""
    save_config(cfg)
    return public_config(cfg)


@app.get("/api/models")
async def list_models():
    cfg = load_config()
    try:
        r = await client().get(_endpoint(cfg, "/models"), headers=_headers(cfg), timeout=20)
        if r.status_code != 200:
            return {"models": [], "error": _err_text(r.text, r.status_code)}
        data = r.json().get("data") or r.json().get("models") or []
        ids = sorted({(m.get("id") or m.get("name")) for m in data if isinstance(m, dict)} - {None})
        return {"models": ids}
    except Exception as e:
        return {"models": [], "error": repr(e)}


@app.post("/api/test")
async def test_connection():
    cfg = load_config()
    out = await chat_once(cfg, [{"role": "user", "content": "请只回复：OK"}], cfg.get("model"), 0)
    return {"ok": True, "reply": out[:200]}


@app.post("/api/cache/clear")
async def clear_cache():
    with _db_lock:
        _db.execute("DELETE FROM tcache")
        _db.commit()
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_exc(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ---------------------------------------------------------------- 静态文件

STATIC = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import argparse
    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    a = ap.parse_args()
    print(f"\n  PDF 翻译助手已启动： http://{a.host}:{a.port}\n")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
