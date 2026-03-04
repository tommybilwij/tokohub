"""Application settings — loaded from profiles/application.yml, overridden by env vars / .env."""

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, YamlConfigSettingsSource

_BASE_DIR = Path(__file__).parent


def _get_yaml_config_path(file_name: str = "application.yml") -> Path:
    return _BASE_DIR / "profiles" / file_name


class DatabaseSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='DB_')

    host: str = '192.168.5.25'
    port: int = 3306
    user: str = 'root'
    password: str = ''
    name: str = 'myposse'
    charset: str = 'latin1'
    pool_size: int = 5

    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings,
    ):
        # env vars (DB_HOST, DB_PORT, etc.) override init kwargs (from YAML)
        return (env_settings, dotenv_settings, init_settings)

    def to_connector_kwargs(self) -> dict:
        return {
            'host': self.host,
            'port': self.port,
            'user': self.user,
            'password': self.password,
            'database': self.name,
            'charset': self.charset,
            'pool_name': 'myposse_pool',
            'pool_size': self.pool_size,
        }


class OpenAISettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='OPENAI_')

    api_base: str = ''
    api_key: str = ''
    deployment_id: str = 'gpt-4o-standard'
    api_version: str = '2024-08-01-preview'

    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings,
    ):
        return (env_settings, dotenv_settings, init_settings)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.envrc',
        extra='ignore',
        env_nested_delimiter='__',
        env_file_encoding='utf-8',
        case_sensitive=False,
    )

    upload_folder: Path = _BASE_DIR / 'uploads'
    log_folder: Path = _BASE_DIR / 'logs'
    allowed_extensions: set[str] = {'png', 'jpg', 'jpeg', 'csv', 'xlsx'}
    max_content_length: int = 16 * 1024 * 1024

    # Fuzzy matching
    fuzzy_cache_ttl: int = 300
    fuzzy_top_n: int = 5
    fuzzy_min_score: int = 40

    # Server
    server_port: int = 5000
    server_host: str = '127.0.0.1'

    # LAN mode
    lan_mode: bool = False

    # Database
    db: DatabaseSettings = Field(default_factory=DatabaseSettings)

    # Azure OpenAI
    openai: OpenAISettings = Field(default_factory=OpenAISettings)

    @model_validator(mode='before')
    @classmethod
    def _rebuild_nested_from_env(cls, values):
        """Reconstruct nested BaseSettings so their env vars override YAML defaults."""
        for name, field in cls.model_fields.items():
            val = values.get(name)
            if isinstance(val, dict):
                anno = field.annotation
                if isinstance(anno, type) and issubclass(anno, BaseSettings):
                    values[name] = anno(**val)
        return values

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls,
        init_settings,
        env_settings,
        dotenv_settings,
        file_secret_settings,
    ):
        sources = [
            init_settings,
            env_settings,
            dotenv_settings,
        ]

        # Profile-specific YAML (e.g. APP_PROFILE=production → application-production.yml)
        profile = os.getenv('APP_PROFILE')
        if profile:
            profile_path = _get_yaml_config_path(f'application-{profile.lower()}.yml')
            if profile_path.exists():
                sources.append(YamlConfigSettingsSource(settings_cls, profile_path))

        # Default YAML
        default_path = _get_yaml_config_path()
        if default_path.exists():
            sources.append(YamlConfigSettingsSource(settings_cls, default_path))

        return tuple(sources)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
