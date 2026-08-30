FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/api /app/apps/api
RUN pip install --no-cache-dir /app/apps/api

EXPOSE 8820

CMD ["mabel-api", "serve", "--host", "0.0.0.0", "--port", "8820"]
