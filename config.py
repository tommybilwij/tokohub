"""Application settings — loaded from profiles/application.yml, overridden by env vars / .env."""

import os
import sys
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, YamlConfigSettingsSource

_BASE_DIR = Path(__file__).parent

# Determine .envrc location: frozen builds use a stable user-writable path
if getattr(sys, 'frozen', False):
    _USER_DATA_DIR = Path.home() / '.tokohub'
    _ENVRC_PATH =  _USER_DATA_DIR / '.envrc'
else:
    _USER_DATA_DIR = _BASE_DIR
    _ENVRC_PATH = _BASE_DIR / '.envrc'

# Load .envrc into os.environ BEFORE constructing any settings.
# This is critical for frozen/Tauri builds where the shell doesn't source .envrc.
# DatabaseSettings / OpenAISettings read from os.environ (env_prefix), not env_file.
load_dotenv(_ENVRC_PATH, override=False)


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
    pool_size: int = 10

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
        env_file=str(_ENVRC_PATH),
        extra='ignore',
        env_nested_delimiter='__',
        env_file_encoding='utf-8',
        case_sensitive=False,
    )

    upload_folder: Path = _USER_DATA_DIR / 'uploads'
    log_folder: Path = _USER_DATA_DIR / 'logs'
    allowed_extensions: set[str] = {'png', 'jpg', 'jpeg'}
    max_content_length: int = 16 * 1024 * 1024

    # Fuzzy matching (Input Barang)
    fuzzy_cache_ttl: int = 300
    fuzzy_top_n: int = 5
    fuzzy_min_score: int = 40

    # Fuzzy matching (Perubahan Harga)
    pc_top_n: int = 10
    pc_min_score: int = 30

    # Server
    server_port: int = 5000
    server_host: str = '127.0.0.1'

    # LAN mode
    lan_mode: bool = True
    mdns_hostname: str = 'tokohub'

    # Session
    session_max_age: int = 86400  # 1 day in seconds

    # Branding
    store_name: str = ''

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


# ---------------------------------------------------------------------------
# Env-var ↔ config key mapping
# ---------------------------------------------------------------------------

_KEY_TO_ENV = {
    'db.host': 'DB_HOST',
    'db.port': 'DB_PORT',
    'db.user': 'DB_USER',
    'db.password': 'DB_PASSWORD',
    'db.name': 'DB_NAME',
    'db.pool_size': 'DB_POOL_SIZE',
    'openai.api_base': 'OPENAI_API_BASE',
    'openai.api_key': 'OPENAI_API_KEY',
    'openai.deployment_id': 'OPENAI_DEPLOYMENT_ID',
    'openai.api_version': 'OPENAI_API_VERSION',
    'fuzzy_cache_ttl': 'FUZZY_CACHE_TTL',
    'fuzzy_top_n': 'FUZZY_TOP_N',
    'fuzzy_min_score': 'FUZZY_MIN_SCORE',
    'pc_top_n': 'PC_TOP_N',
    'pc_min_score': 'PC_MIN_SCORE',
    'server_port': 'SERVER_PORT',
    'server_host': 'SERVER_HOST',
    'lan_mode': 'LAN_MODE',
    'mdns_hostname': 'MDNS_HOSTNAME',
    'store_name': 'STORE_NAME',
    'session_max_age': 'SESSION_MAX_AGE',
}


def save_to_envrc(data: dict) -> None:
    """Persist config values to .envrc and update the running process env + settings."""
    envrc_path = _ENVRC_PATH
    envrc_path.parent.mkdir(parents=True, exist_ok=True)

    # Build env-var updates from the flat dotted keys
    env_updates: dict[str, str] = {}
    for dotted_key, env_var in _KEY_TO_ENV.items():
        parts = dotted_key.split('.')
        # Navigate into data dict
        val = data
        for p in parts:
            if isinstance(val, dict):
                val = val.get(p, _SENTINEL)
            else:
                val = _SENTINEL
                break
        if val is not _SENTINEL:
            env_updates[env_var] = str(val)

    if not env_updates:
        return

    # Read existing .envrc lines
    lines: list[str] = []
    if envrc_path.exists():
        lines = envrc_path.read_text(encoding='utf-8').splitlines()

    # Update or append each env var
    handled: set[str] = set()
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        matched = False
        for env_var, value in env_updates.items():
            if stripped.startswith(f'export {env_var}=') or stripped.startswith(f'{env_var}='):
                new_lines.append(f'export {env_var}="{value}"')
                handled.add(env_var)
                matched = True
                break
        if not matched:
            new_lines.append(line)

    # Append any new keys not already in the file
    for env_var, value in env_updates.items():
        if env_var not in handled:
            new_lines.append(f'export {env_var}="{value}"')

    envrc_path.write_text('\n'.join(new_lines) + '\n', encoding='utf-8')

    # Update os.environ so the running process picks up changes immediately
    for env_var, value in env_updates.items():
        os.environ[env_var] = value

    # Reload the settings singleton
    reload_settings()


def reload_settings() -> None:
    """Clear cached settings and rebuild the singleton."""
    global settings
    get_settings.cache_clear()
    settings = get_settings()


_SENTINEL = object()
