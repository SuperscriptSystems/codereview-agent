# Dockerfile

# --- Етап 1: Встановлення залежностей ---
FROM python:3.11-slim as builder

# Встановлюємо Poetry
ENV POETRY_HOME="/opt/poetry"
RUN python3 -m venv $POETRY_HOME
ENV PATH="$POETRY_HOME/bin:$PATH"
RUN pip install --upgrade pip && pip install poetry

WORKDIR /app

COPY poetry.lock pyproject.toml ./

RUN poetry install --no-root --without dev

FROM python:3.11-slim

WORKDIR /app


COPY --from=builder /app/.venv /app/.venv

COPY src/ /app/src/
COPY pyproject.toml .

ENV PATH="/app/.venv/bin:$PATH"

RUN pip install .

ENTRYPOINT ["code-review-agent"]
CMD ["--help"]