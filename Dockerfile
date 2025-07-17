FROM python:3.11-slim as builder

RUN pip install poetry

WORKDIR /app

COPY pyproject.toml poetry.lock ./

RUN poetry install --no-dev --no-interaction --no-ansi

FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /root/.cache/pypoetry/virtualenvs/ /root/.cache/pypoetry/virtualenvs/

COPY --from=builder /app/pyproject.toml /app/

COPY src/ /app/src/

RUN poetry config virtualenvs.in-project false --local \
    && poetry config virtualenvs.path /root/.cache/pypoetry/virtualenvs

ENTRYPOINT ["poetry", "run", "code-review-agent"]
CMD ["--help"]