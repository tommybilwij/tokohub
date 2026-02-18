"""Reusable Azure OpenAI client."""

import base64
import logging
import mimetypes
from pathlib import Path

from openai import AzureOpenAI

from config import settings

logger = logging.getLogger(__name__)

_client: AzureOpenAI | None = None


def _get_client() -> AzureOpenAI:
    """Lazy-init singleton Azure OpenAI client."""
    global _client
    if _client is None:
        cfg = settings.openai
        _client = AzureOpenAI(
            azure_endpoint=cfg.api_base,
            api_key=cfg.api_key,
            api_version=cfg.api_version,
        )
    return _client


def chat_completion(messages: list[dict], **kwargs) -> str:
    """Send a chat completion request and return the assistant message content."""
    client = _get_client()
    deployment = kwargs.pop('deployment', None) or settings.openai.deployment_id

    response = client.chat.completions.create(
        model=deployment,
        messages=messages,
        **kwargs,
    )
    result = response.choices[0].message.content
    usage = response.usage
    logger.debug("LLM usage: prompt=%d completion=%d total=%d",
                 usage.prompt_tokens, usage.completion_tokens, usage.total_tokens)
    return result


def vision_completion(image_path: str | Path, prompt: str, **kwargs) -> str:
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
    return chat_completion(messages, **kwargs)
