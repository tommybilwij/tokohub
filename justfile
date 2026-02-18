# Stock Entry MyPosse

set dotenv-load

db_host := env("DB_HOST", "127.0.0.1")
db_port := env("DB_PORT", "3388")
db_user := env("DB_USER", "root")
db_password := env("DB_PASSWORD", "")
db_name := env("DB_NAME", "myposse")
db_data := justfile_directory() / ".mariadb-data"
backup_dir := justfile_directory() / "backups"

default:
    @just --list

# Install dependencies
install:
    uv sync

# Run the dev server
run:
    uv run python app.py

# Run on a specific port
run-port port="5000":
    uv run flask run --host 0.0.0.0 --port {{port}} --debug

# Initialize local MariaDB data directory
db-init:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -d "{{db_data}}/mysql" ]; then
        echo "Data directory already initialized at {{db_data}}"
        exit 0
    fi
    echo "Initializing MariaDB data directory at {{db_data}}..."
    mkdir -p "{{db_data}}"
    mysql_install_db --datadir="{{db_data}}" --auth-root-authentication-method=normal 2>&1
    echo "Done."

# Start local MariaDB server (port from .env, default 3388)
db-start: db-init
    #!/usr/bin/env bash
    set -euo pipefail
    if mariadb-admin --socket="{{db_data}}/mysql.sock" ping 2>/dev/null; then
        echo "MariaDB already running on port {{db_port}}"
        exit 0
    fi
    echo "Starting MariaDB on 0.0.0.0:{{db_port}}..."
    mariadbd-safe \
        --datadir="{{db_data}}" \
        --port={{db_port}} \
        --bind-address=0.0.0.0 \
        --socket="{{db_data}}/mysql.sock" \
        --skip-grant-tables \
        &
    # Wait for server to be ready
    for i in $(seq 1 30); do
        if mariadb-admin --socket="{{db_data}}/mysql.sock" ping 2>/dev/null; then
            echo "MariaDB started on port {{db_port}}"
            exit 0
        fi
        sleep 1
    done
    echo "ERROR: MariaDB failed to start within 30s"
    exit 1

# Stop local MariaDB server
db-stop:
    #!/usr/bin/env bash
    set -euo pipefail
    if mariadb-admin --socket="{{db_data}}/mysql.sock" ping 2>/dev/null; then
        mariadb-admin --socket="{{db_data}}/mysql.sock" shutdown
        echo "MariaDB stopped."
    else
        echo "MariaDB is not running."
    fi

# Show MariaDB server status
db-status:
    #!/usr/bin/env bash
    if mariadb-admin --socket="{{db_data}}/mysql.sock" ping 2>/dev/null; then
        echo "MariaDB is running on port {{db_port}}"
        mariadb --socket="{{db_data}}/mysql.sock" -u root -e "SHOW DATABASES;"
    else
        echo "MariaDB is not running."
    fi

# Import backup SQL files and create app database
db-import: db-start
    #!/usr/bin/env bash
    set -euo pipefail
    SOCK="{{db_data}}/mysql.sock"
    echo "Creating databases if not exist..."
    mariadb --socket="$SOCK" -u root -e "CREATE DATABASE IF NOT EXISTS {{db_name}};"
    mariadb --socket="$SOCK" -u root -e "CREATE DATABASE IF NOT EXISTS myposse_users;"
    echo "Importing {{db_name}} backup (this may take a while for large files)..."
    iconv -f UTF-16LE -t UTF-8 "{{backup_dir}}/myposse_backup.sql" | sed '1s/^\xEF\xBB\xBF//' | mariadb --socket="$SOCK" -u root {{db_name}}
    echo "Importing myposse_users backup..."
    iconv -f UTF-16LE -t UTF-8 "{{backup_dir}}/myposse_users_backup.sql" | sed '1s/^\xEF\xBB\xBF//' | mariadb --socket="$SOCK" -u root myposse_users
    echo "Import complete!"

# Create the stock_alias table in the database
migrate: db-start
    #!/usr/bin/env bash
    set -euo pipefail
    SOCK="{{db_data}}/mysql.sock"
    mariadb --socket="$SOCK" -u root {{db_name}} < schema/stock_alias.sql
    echo "stock_alias table created."

# Connect to local MariaDB shell
db-shell:
    mariadb --socket="{{db_data}}/mysql.sock" -u root {{db_name}}

# Check DB connectivity
check-db:
    uv run python -c "from services.db import execute_single; r=execute_single('SELECT 1 AS ok'); print('DB OK' if r else 'DB FAIL')"

# List stock items (quick sanity check)
check-stock:
    uv run python -c "from services.db import execute_single; r=execute_single('SELECT COUNT(*) AS n FROM stock WHERE isactive=1'); print(f'{r[\"n\"]} active stock items')"

# Full setup: install deps, start db, import data, run migrations
setup: install db-import migrate
    @echo "Setup complete! Run 'just run' to start the app."

# Clean up local MariaDB data directory
db-clean: db-stop
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -d "{{db_data}}" ]; then
        rm -rf "{{db_data}}"
        echo "Cleaned up {{db_data}}"
    else
        echo "Nothing to clean."
    fi
