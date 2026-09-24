import json
import os
import re
import time
import uuid
import logging
import asyncio
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("llm-bridge")

app = FastAPI(title="Anthropic to Groq Bridge with Redis Queue")

GROQ_BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
DEFAULT_GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
TARGET_MODEL = os.environ.get("TARGET_MODEL", "qwen/qwen3.8-27b")
MAX_INPUT_CHARS = int(os.environ.get("MAX_INPUT_CHARS", "18000"))  # ~4500 tokens max for Groq free tier
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")


class RedisLLMQueue:
    """Sequential Queue & Rate-Limit Manager backed by Redis.
    Ensures that multiple concurrent meeting summaries or LLM prompts are queued
    and processed one-by-one with rate-limit pacing and automatic 429 backoff."""

    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self.redis: Optional[aioredis.Redis] = None
        self._local_lock = asyncio.Lock()
        self._last_call_time = 0.0
        self._min_interval = 1.5  # Seconds between inferences

    async def get_client(self) -> Optional[aioredis.Redis]:
        if self.redis is None:
            try:
                self.redis = aioredis.from_url(
                    self.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=3.0,
                    socket_timeout=5.0
                )
                await self.redis.ping()
                logger.info(f"Connected to Redis queue at {self.redis_url}")
            except Exception as e:
                logger.warning(f"Could not connect to Redis at {self.redis_url} ({e}); using local async queue")
                self.redis = None
        return self.redis

    async def acquire(self, req_id: str) -> Optional[Any]:
        # 1. Local async lock
        await self._local_lock.acquire()

        # 2. Redis distributed lock
        redis_lock = None
        rc = await self.get_client()
        if rc is not None:
            try:
                await rc.incr("vexa:llm:queue:waiting")
                waiting = await rc.get("vexa:llm:queue:waiting")
                logger.info(f"[{req_id}] Queued in Redis LLM queue. (Total waiting: {waiting})")

                redis_lock = rc.lock(
                    "vexa:llm:lock",
                    timeout=180.0,
                    blocking_timeout=300.0,
                    sleep=0.3
                )
                await redis_lock.acquire()
                await rc.decr("vexa:llm:queue:waiting")
                logger.info(f"[{req_id}] Acquired global Redis LLM lock. Executing inference...")
            except Exception as e:
                logger.warning(f"[{req_id}] Redis lock warning: {e}. Continuing with local lock.")
                if rc:
                    try:
                        await rc.decr("vexa:llm:queue:waiting")
                    except Exception:
                        pass
                redis_lock = None

        # 3. Minimum cooldown interval
        now = time.time()
        elapsed = now - self._last_call_time
        if elapsed < self._min_interval:
            await asyncio.sleep(self._min_interval - elapsed)

        return redis_lock

    async def release(self, req_id: str, redis_lock: Optional[Any]):
        self._last_call_time = time.time()
        if redis_lock is not None:
            try:
                await redis_lock.release()
                logger.info(f"[{req_id}] Released Redis LLM lock.")
            except Exception as e:
                logger.warning(f"[{req_id}] Error releasing Redis lock: {e}")
        if self._local_lock.locked():
            self._local_lock.release()

    async def get_status(self) -> Dict[str, Any]:
        rc = await self.get_client()
        waiting = 0
        is_locked = False
        if rc is not None:
            try:
                w = await rc.get("vexa:llm:queue:waiting")
                waiting = int(w or 0)
                is_locked = bool(await rc.exists("vexa:llm:lock"))
            except Exception:
                pass
        return {
            "redis_connected": rc is not None,
            "waiting_in_queue": waiting,
            "is_busy": is_locked or self._local_lock.locked(),
            "target_model": TARGET_MODEL
        }


llm_queue = RedisLLMQueue(REDIS_URL)


@app.get("/health")
async def health():
    status = await llm_queue.get_status()
    return {"status": "ok", "target_model": TARGET_MODEL, "target_url": GROQ_BASE_URL, "queue": status}


@app.get("/queue/status")
async def queue_status():
    return await llm_queue.get_status()


@app.get("/v1/models")
@app.get("/models")
async def list_models():
    models = [
        "claude-3-5-haiku-20241022",
        "claude-3-5-sonnet-20241022",
        "claude-3-haiku-20240307",
        "claude-3-opus-20240229",
        "claude-2.1",
        "claude-2.0",
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        TARGET_MODEL,
    ]
    return {
        "object": "list",
        "data": [{"id": m, "object": "model", "created": int(time.time()), "owned_by": "anthropic"} for m in models]
    }


def extract_api_key(request: Request, x_api_key: Optional[str] = None, authorization: Optional[str] = None) -> str:
    if x_api_key and x_api_key.strip():
        return x_api_key.strip()
    if authorization:
        parts = authorization.strip().split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1]
        return authorization.strip()
    return DEFAULT_GROQ_API_KEY


def convert_anthropic_to_openai_tools(tools: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    # Keep tools compact so they don't blow up token limits
    openai_tools = []
    for tool in tools:
        schema = tool.get("input_schema", {"type": "object", "properties": {}})
        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool.get("name", ""),
                "description": (tool.get("description", "") or "")[:200],
                "parameters": schema
            }
        })
    return openai_tools[:6]  # Limit to top tools


def trim_text(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    # Keep beginning and end
    half = max_len // 2
    return text[:half] + "\n\n... [context trimmed for speed] ...\n\n" + text[-half:]


def convert_anthropic_messages_to_openai(
    messages: List[Dict[str, Any]],
    system: Optional[Union[str, List[Dict[str, Any]]]] = None
) -> List[Dict[str, Any]]:
    openai_msgs: List[Dict[str, Any]] = []

    # Handle system prompt
    if system:
        if isinstance(system, str):
            sys_text = system
        elif isinstance(system, list):
            sys_text = "\n\n".join(b.get("text", "") for b in system if isinstance(b, dict) and b.get("type") == "text")
        else:
            sys_text = str(system)
        sys_text = trim_text(sys_text.strip(), 4000)
        if sys_text:
            openai_msgs.append({"role": "system", "content": sys_text})

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, str):
            openai_msgs.append({"role": role, "content": trim_text(content, MAX_INPUT_CHARS)})
        elif isinstance(content, list):
            text_parts = []
            tool_calls = []
            tool_results = []

            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_calls.append({
                        "id": block.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": json.dumps(block.get("input", {}))
                        }
                    })
                elif btype == "tool_result":
                    res_content = block.get("content", "")
                    if isinstance(res_content, list):
                        res_content = " ".join(b.get("text", "") for b in res_content if isinstance(b, dict) and b.get("type") == "text")
                    tool_results.append({
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id", ""),
                        "content": trim_text(str(res_content), 4000)
                    })

            if role == "assistant" and tool_calls:
                msg_dict = {"role": "assistant"}
                if text_parts:
                    msg_dict["content"] = trim_text("\n".join(text_parts), MAX_INPUT_CHARS)
                msg_dict["tool_calls"] = tool_calls
                openai_msgs.append(msg_dict)
            elif role == "user" and tool_results:
                for tr in tool_results:
                    openai_msgs.append(tr)
                if text_parts:
                    openai_msgs.append({"role": "user", "content": trim_text("\n".join(text_parts), MAX_INPUT_CHARS)})
            else:
                combined_text = trim_text("\n".join(text_parts), MAX_INPUT_CHARS)
                openai_msgs.append({"role": role, "content": combined_text})
        else:
            openai_msgs.append({"role": role, "content": trim_text(str(content), MAX_INPUT_CHARS)})

    return openai_msgs


@app.post("/v1/messages")
@app.post("/messages")
async def messages_endpoint(
    request: Request,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    body = await request.json()
    api_key = extract_api_key(request, x_api_key, authorization)
    if not api_key:
        raise HTTPException(status_code=401, detail="API key is required")

    req_model = body.get("model", "claude-3-5-haiku-20241022")
    stream = body.get("stream", False)
    max_tokens = min(body.get("max_tokens", 2048), 3000)
    temperature = body.get("temperature", 0.7)

    openai_messages = convert_anthropic_messages_to_openai(body.get("messages", []), body.get("system"))
    
    # Calculate approximate size to avoid 413
    total_len = sum(len(str(m.get("content", ""))) for m in openai_messages)
    logger.info(f"Incoming /v1/messages: model={req_model}, stream={stream}, total_chars={total_len}")

    payload: Dict[str, Any] = {
        "model": TARGET_MODEL,
        "messages": openai_messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }

    # Attach tools if present
    if body.get("tools"):
        tools = convert_anthropic_to_openai_tools(body.get("tools"))
        if tools:
            payload["tools"] = tools

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "vexa/0.12",
    }

    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    if stream:
        redis_lock = await llm_queue.acquire(msg_id)

        async def event_generator() -> AsyncGenerator[str, None]:
            try:
                start_event = {
                    "type": "message_start",
                    "message": {
                        "id": msg_id,
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "model": req_model,
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 100, "output_tokens": 0}
                    }
                }
                yield f"event: message_start\ndata: {json.dumps(start_event)}\n\n"

                content_block_started = False
                tool_block_started = False
                current_tool_index = 0
                output_tokens = 0

                async with httpx.AsyncClient(verify=False, timeout=120.0) as client:
                    async with client.stream("POST", f"{GROQ_BASE_URL}/chat/completions", json=payload, headers=headers) as resp:
                        if resp.status_code != 200:
                            err_text = await resp.aread()
                            logger.error(f"Groq API error {resp.status_code}: {err_text.decode('utf-8', errors='ignore')}")
                            # If 413 or rate limit, retry once with aggressively trimmed context
                            if resp.status_code == 413 and len(openai_messages) > 0:
                                logger.info("Retrying with ultra-trimmed context...")
                                trimmed_msgs = [openai_messages[-1]]
                                retry_payload = {
                                    "model": TARGET_MODEL,
                                    "messages": trimmed_msgs,
                                    "max_tokens": max_tokens,
                                    "temperature": temperature,
                                    "stream": True
                                }
                                async with client.stream("POST", f"{GROQ_BASE_URL}/chat/completions", json=retry_payload, headers=headers) as r2:
                                    if r2.status_code == 200:
                                        async for line in r2.aiter_lines():
                                            line = line.strip()
                                            if not line or not line.startswith("data:"):
                                                continue
                                            data_str = line[5:].strip()
                                            if data_str == "[DONE]":
                                                break
                                            try:
                                                chunk = json.loads(data_str)
                                            except json.JSONDecodeError:
                                                continue
                                            choices = chunk.get("choices", [])
                                            if not choices:
                                                continue
                                            delta = choices[0].get("delta", {})
                                            text_chunk = delta.get("content")
                                            if text_chunk:
                                                if not content_block_started:
                                                    block_start = {
                                                        "type": "content_block_start",
                                                        "index": 0,
                                                        "content_block": {"type": "text", "text": ""}
                                                    }
                                                    yield f"event: content_block_start\ndata: {json.dumps(block_start)}\n\n"
                                                    content_block_started = True
                                                delta_event = {
                                                    "type": "content_block_delta",
                                                    "index": 0,
                                                    "delta": {"type": "text_delta", "text": text_chunk}
                                                }
                                                yield f"event: content_block_delta\ndata: {json.dumps(delta_event)}\n\n"
                                                output_tokens += 1
                            else:
                                error_delta = {
                                    "type": "error",
                                    "error": {
                                        "type": "api_error",
                                        "message": f"Groq API error ({resp.status_code}): {err_text.decode('utf-8', errors='ignore')}"
                                    }
                                }
                                yield f"event: error\ndata: {json.dumps(error_delta)}\n\n"
                                return
                        else:
                            async for line in resp.aiter_lines():
                                line = line.strip()
                                if not line or not line.startswith("data:"):
                                    continue
                                data_str = line[5:].strip()
                                if data_str == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(data_str)
                                except json.JSONDecodeError:
                                    continue

                                choices = chunk.get("choices", [])
                                if not choices:
                                    continue
                                delta = choices[0].get("delta", {})

                                # Text delta
                                text_chunk = delta.get("content")
                                if text_chunk:
                                    if not content_block_started:
                                        block_start = {
                                            "type": "content_block_start",
                                            "index": 0,
                                            "content_block": {"type": "text", "text": ""}
                                        }
                                        yield f"event: content_block_start\ndata: {json.dumps(block_start)}\n\n"
                                        content_block_started = True

                                    delta_event = {
                                        "type": "content_block_delta",
                                        "index": 0,
                                        "delta": {"type": "text_delta", "text": text_chunk}
                                    }
                                    yield f"event: content_block_delta\ndata: {json.dumps(delta_event)}\n\n"
                                    output_tokens += 1

                                # Tool calls
                                tool_calls = delta.get("tool_calls", [])
                                for tc in tool_calls:
                                    tc_index = tc.get("index", 0) + (1 if content_block_started else 0)
                                    fn = tc.get("function", {})
                                    name = fn.get("name")
                                    args = fn.get("arguments")
                                    call_id = tc.get("id")

                                    if call_id and name:
                                        current_tool_index = tc_index
                                        tool_start = {
                                            "type": "content_block_start",
                                            "index": current_tool_index,
                                            "content_block": {
                                                "type": "tool_use",
                                                "id": call_id,
                                                "name": name,
                                                "input": {}
                                            }
                                        }
                                        yield f"event: content_block_start\ndata: {json.dumps(tool_start)}\n\n"
                                        tool_block_started = True

                                    if args:
                                        delta_tool = {
                                            "type": "content_block_delta",
                                            "index": current_tool_index,
                                            "delta": {
                                                "type": "input_json_delta",
                                                "partial_json": args
                                            }
                                        }
                                        yield f"event: content_block_delta\ndata: {json.dumps(delta_tool)}\n\n"

                if content_block_started:
                    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
                if tool_block_started:
                    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_tool_index})}\n\n"

                msg_delta = {
                    "type": "message_delta",
                    "delta": {"stop_reason": "tool_use" if tool_block_started else "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": output_tokens}
                }
                yield f"event: message_delta\ndata: {json.dumps(msg_delta)}\n\n"
                yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"
            finally:
                await llm_queue.release(msg_id, redis_lock)

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    else:
        redis_lock = await llm_queue.acquire(msg_id)
        try:
            data = None
            max_retries = 3
            for attempt in range(max_retries):
                async with httpx.AsyncClient(verify=False, timeout=120.0) as client:
                    resp = await client.post(f"{GROQ_BASE_URL}/chat/completions", json=payload, headers=headers)
                    if resp.status_code == 429 and attempt < max_retries - 1:
                        err_text = resp.text
                        match = re.search(r"try again in ([\d\.]+)s", err_text)
                        wait_secs = float(match.group(1)) + 1.0 if match else 6.0
                        logger.warning(f"[{msg_id}] 429 Rate Limit. Waiting {wait_secs:.1f}s in queue before retry...")
                        await asyncio.sleep(wait_secs)
                        continue
                    if resp.status_code != 200:
                        raise HTTPException(status_code=resp.status_code, detail=resp.text)
                    data = resp.json()
                    break

            if not data:
                raise HTTPException(status_code=502, detail="No response from LLM inference")

            choice = data.get("choices", [{}])[0]
            msg = choice.get("message", {})
            text_content = msg.get("content", "")
            tool_calls = msg.get("tool_calls", [])

            content_blocks = []
            if text_content:
                content_blocks.append({"type": "text", "text": text_content})
            for tc in tool_calls:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except json.JSONDecodeError:
                    args = {}
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                    "name": fn.get("name", ""),
                    "input": args
                })

            usage = data.get("usage", {})
            return {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "content": content_blocks,
                "model": req_model,
                "stop_reason": "tool_use" if tool_calls else "end_turn",
                "stop_sequence": None,
                "usage": {
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": usage.get("completion_tokens", 0)
                }
            }
        finally:
            await llm_queue.release(msg_id, redis_lock)


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions_passthrough(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    body = await request.json()
    api_key = extract_api_key(request, None, authorization)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "vexa/0.12"
    }
    body["model"] = TARGET_MODEL
    req_id = f"chat_{uuid.uuid4().hex[:12]}"

    redis_lock = await llm_queue.acquire(req_id)
    try:
        max_retries = 3
        for attempt in range(max_retries):
            async with httpx.AsyncClient(verify=False, timeout=120.0) as client:
                resp = await client.post(f"{GROQ_BASE_URL}/chat/completions", json=body, headers=headers)
                if resp.status_code == 429 and attempt < max_retries - 1:
                    err_text = resp.text
                    match = re.search(r"try again in ([\d\.]+)s", err_text)
                    wait_secs = float(match.group(1)) + 1.0 if match else 6.0
                    logger.warning(f"[{req_id}] Groq 429 Rate Limit. Sleeping {wait_secs:.1f}s in queue before retry...")
                    await asyncio.sleep(wait_secs)
                    continue
                return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    finally:
        await llm_queue.release(req_id, redis_lock)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "4000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
