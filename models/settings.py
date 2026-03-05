"""Pydantic models for settings endpoints."""

from pydantic import BaseModel


class DatabaseSettingsUpdate(BaseModel):
    host: str | None = None
    port: int | None = None
    user: str | None = None
    password: str | None = None
    name: str | None = None
    pool_size: int | None = None


class OpenAISettingsUpdate(BaseModel):
    api_base: str | None = None
    api_key: str | None = None
    deployment_id: str | None = None
    api_version: str | None = None


class SettingsUpdate(BaseModel):
    db: DatabaseSettingsUpdate | None = None
    openai: OpenAISettingsUpdate | None = None
    fuzzy_cache_ttl: int | None = None
    fuzzy_top_n: int | None = None
    fuzzy_min_score: int | None = None
    server_port: int | None = None
    server_host: str | None = None
    lan_mode: bool | None = None
    mdns_hostname: str | None = None
    store_name: str | None = None
