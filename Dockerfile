# Dockerfile

FROM python:3.11-slim as requirements_stage

RUN pip install poetry poetry-plugin-export

WORKDIR /app
COPY pyproject.toml poetry.lock ./

RUN poetry export -f requirements.txt --output requirements.txt --without-hashes --without dev

FROM python:3.11-slim as builder

WORKDIR /app

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --from=requirements_stage /app/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

COPY src/ /app/src/
COPY pyproject.toml .

ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-deps .

ENTRYPOINT ["code-review-agent"]
CMD ["--help"]