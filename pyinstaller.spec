# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for tokohub-server (--onedir mode)

import os

block_cipher = None
base_dir = os.path.abspath('.')

a = Analysis(
    ['app.py'],
    pathex=[base_dir],
    binaries=[],
    datas=[
        ('templates', 'templates'),
        ('static', 'static'),
        ('schema', 'schema'),
        ('profiles', 'profiles'),
    ],
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.lifespan.on',
        'fastapi',
        'starlette',
        'starlette.middleware',
        'starlette.middleware.base',
        'multipart',
        'multipart.multipart',
        'aiomysql',
        'pymysql',
        'pydantic',
        'pydantic_settings',
        'pydantic_settings.yaml_config',
        'yaml',
        'rapidfuzz',
        'rapidfuzz.process',
        'rapidfuzz.fuzz',
        'openpyxl',
        'PIL',
        'PIL.Image',
        'PIL.ImageFilter',
        'cryptography',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='tokohub-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # Tauri captures stdout/stderr
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='tokohub-server',
)
