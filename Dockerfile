# Dockerfile

FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry

COPY pyproject.toml poetry.lock ./

RUN poetry install && poetry export -f requirements.txt --output requirements.txt --without-hashes

RUN python -m venv /opt/venv

RUN /opt/venv/bin/pip install -r requirements.txt

COPY src/ /app/src/

RUN /opt/venv/bin/pip install .

ENV PATH="/opt/venv/bin:$PATH"

ENTRYPOINT ["code-review-agent"]
CMD ["--help"]