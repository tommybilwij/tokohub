"""Reusable async Azure OpenAI client with config from DB."""

import base64
import logging
import mimetypes
from pathlib import Path

from openai import AsyncAzureOpenAI

from services.db import execute_single, execute_modify

logger = logging.getLogger(__name__)

_client: AsyncAzureOpenAI | None = None
_cached_cfg: dict | None = None


async def get_openai_config(pool) -> dict:
    """Load OpenAI config from DB (single row, id=1)."""
    row = await execute_single(pool, "SELECT api_base, api_key, deployment_id, api_version FROM tokohub.openai_config WHERE id = 1")
    if not row:
        return {'api_base': '', 'api_key': '', 'deployment_id': 'gpt-4o-standard', 'api_version': '2024-08-01-preview'}
    return dict(row)


async def save_openai_config(pool, cfg: dict) -> None:
    """Save OpenAI config to DB (upsert single row)."""
    global _client, _cached_cfg
    await execute_modify(
        pool,
        "INSERT INTO tokohub.openai_config (id, api_base, api_key, deployment_id, api_version) "
        "VALUES (1, %s, %s, %s, %s) "
        "ON DUPLICATE KEY UPDATE api_base=VALUES(api_base), api_key=VALUES(api_key), "
        "deployment_id=VALUES(deployment_id), api_version=VALUES(api_version)",
        (cfg.get('api_base', ''), cfg.get('api_key', ''), cfg.get('deployment_id', 'gpt-4o-standard'), cfg.get('api_version', '2024-08-01-preview')),
    )
    _client = None
    _cached_cfg = None


async def _get_client(pool) -> AsyncAzureOpenAI:
    """Lazy-init singleton async Azure OpenAI client from DB config."""
    global _client, _cached_cfg
    if _client is None:
        cfg = await get_openai_config(pool)
        _cached_cfg = cfg
        if not cfg['api_base'] or not cfg['api_key']:
            raise ValueError("OpenAI belum dikonfigurasi. Atur di Settings.")
        _client = AsyncAzureOpenAI(
            azure_endpoint=cfg['api_base'],
            api_key=cfg['api_key'],
            api_version=cfg['api_version'],
        )
    return _client


async def chat_completion(pool, messages: list[dict], **kwargs) -> str:
    """Send a chat completion request and return the assistant message content."""
    client = await _get_client(pool)
    deployment = kwargs.pop('deployment', None) or _cached_cfg['deployment_id']

    response = await client.chat.completions.create(
        model=deployment,
        messages=messages,
        **kwargs,
    )
    result = response.choices[0].message.content
    usage = response.usage
    logger.debug("LLM usage: prompt=%d completion=%d total=%d",
                 usage.prompt_tokens, usage.completion_tokens, usage.total_tokens)
    return result


async def vision_completion(pool, image_path: str | Path, prompt: str, **kwargs) -> str:
    """Encode an image to base64 and send as a GPT-4o vision request."""
    image_path = Path(image_path)
    mime_type = mimetypes.guess_type(str(image_path))[0] or 'image/jpeg'
    image_b64 = base64.b64encode(image_path.read_bytes()).decode()

    messages = [
        {
            'role': 'user',
            'content': [
                {
                    'type': 'image_url',
                    'image_url': {
                        'url': f'data:{mime_type};base64,{image_b64}',
                    },
                },
                {
                    'type': 'text',
                    'text': prompt,
                },
            ],
        },
    ]
    return await chat_completion(pool, messages, **kwargs)
