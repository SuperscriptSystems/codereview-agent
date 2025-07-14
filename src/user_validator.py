import app_config

def is_admin(role: str) -> bool:
    return role == app_config.USER_ROLE_ADMIN