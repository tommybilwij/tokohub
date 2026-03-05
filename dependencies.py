"""FastAPI dependency injection callables."""

import aiomysql
from fastapi import Request
from fastapi.templating import Jinja2Templates


async def get_db(request: Request) -> aiomysql.Pool:
    """Inject the DB pool into route handlers."""
    return request.app.state.db_pool


async def get_templates(request: Request) -> Jinja2Templates:
    """Inject Jinja2Templates."""
    return request.app.state.templates
