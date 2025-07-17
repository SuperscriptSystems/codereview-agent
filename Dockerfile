# Dockerfile

FROM python:3.11-slim as builder

ENV POETRY_VERSION=1.8.2
RUN pip install "poetry==$POETRY_VERSION"

WORKDIR /app

COPY poetry.lock pyproject.toml ./

RUN poetry install --no-root --without dev --no-interaction --no-ansi

FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

COPY src/ /app/src/
COPY pyproject.toml .

RUN pip install -e .

ENTRYPOINT ["code-review-agent"]
CMD ["--help"]