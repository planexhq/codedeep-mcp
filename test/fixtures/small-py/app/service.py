"""Service orchestration."""

from . import auth


class Session:
    def helper(self) -> bool:
        return auth.authenticate("admin", "secret")

    def run(self) -> bool:
        return self.helper()
