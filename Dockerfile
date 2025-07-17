FROM python:3.11-slim as builder
WORKDIR /app
RUN pip install poetry
COPY pyproject.toml poetry.lock ./

RUN poetry export -f requirements.txt --output requirements.txt --without-hashes
RUN pip install --prefix=/install -r requirements.txt


FROM python:3.11-slim
WORKDIR /app

COPY --from=builder /install /usr/local
COPY src/ /app/src/

RUN pip install -e .

ENTRYPOINT ["code-review-agent"]
CMD ["--help"]