class User:
    """Represents a user in the system."""
    def __init__(self, username: str, role: str):
        self.username = username
        self.role = role

    def has_permission(self, perm: str) -> bool:
        return perm in self.permissions

class Token:
    def __init__(self, value: str, expires_at: float):
        self.value = value
        self.expires_at = expires_at
