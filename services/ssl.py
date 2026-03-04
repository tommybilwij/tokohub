"""Self-signed SSL certificate generation for local HTTPS development."""

import ipaddress
import logging
import os
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

logger = logging.getLogger(__name__)

_DEFAULT_CERT_DIR = Path(__file__).resolve().parent.parent / '.ssl'
_CERT_FILENAME = 'cert.pem'
_KEY_FILENAME = 'key.pem'


def _get_local_ip() -> str | None:
    """Detect the machine's LAN IP via a UDP probe (no traffic sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except OSError:
        return None


def generate_self_signed_cert(
    cert_dir: Path | str = _DEFAULT_CERT_DIR,
    days_valid: int = 365,
) -> tuple[str, str]:
    """Generate a self-signed cert with SANs for localhost + LAN IP.

    Returns:
        (cert_path, key_path) as absolute path strings.
    """
    cert_dir = Path(cert_dir)
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_path = cert_dir / _CERT_FILENAME
    key_path = cert_dir / _KEY_FILENAME

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    san_entries: list[x509.GeneralName] = [
        x509.DNSName('localhost'),
        x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
    ]
    local_ip = _get_local_ip()
    if local_ip:
        san_entries.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
        logger.info("SSL cert will include SAN for LAN IP %s", local_ip)

    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    now = datetime.now(timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=days_valid))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(key, hashes.SHA256())
    )

    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))

    logger.info("Generated self-signed cert → %s", cert_dir)
    return str(cert_path), str(key_path)


def ensure_ssl_cert(cert_dir: Path | str = _DEFAULT_CERT_DIR) -> tuple[str, str]:
    """Return (cert_path, key_path), generating if missing."""
    cert_dir = Path(cert_dir)
    cert_path = cert_dir / _CERT_FILENAME
    key_path = cert_dir / _KEY_FILENAME

    if cert_path.exists() and key_path.exists():
        return str(cert_path), str(key_path)

    return generate_self_signed_cert(cert_dir)
