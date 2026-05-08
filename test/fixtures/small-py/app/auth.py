"""Authentication module."""

from .utils import hash_password

__all__ = ['authenticate', 'authorize']

def authenticate(username: str, password: str) -> bool:
    """Check credentials against the database."""
    hashed = hash_password(password)
    return hashed == get_stored_hash(username)

def authorize(user, permissions: list[str]) -> bool:
    return any(p in user.permissions for p in permissions)

def _get_stored_hash(username: str) -> str:
    return ""  # stub
