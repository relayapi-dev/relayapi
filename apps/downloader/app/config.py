from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    INTERNAL_API_KEY: str
    PORT: int = 8000
    REQUEST_TIMEOUT: int = 60
    PROXY_URL: str | None = None  # e.g. http://user:pass@gate.iproyal.com:12321

    model_config = {"env_file": ".env"}


settings = Settings()
