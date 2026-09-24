FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn httpx redis

COPY main.py .

EXPOSE 4000

CMD ["python", "main.py"]
