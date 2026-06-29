FROM python:3.11-slim

WORKDIR /app

# Install only server deps (worker runs separately on Mac with Demucs/MPS)
RUN pip install --no-cache-dir \
    "fastapi>=0.115.0" \
    "jinjax>=0.45.0" \
    "uvicorn[standard]>=0.30.0" \
    "python-multipart>=0.0.9" \
    "aiofiles>=23.0.0" \
    "certifi>=2024.0.0"

COPY app/ ./app/
COPY components/ ./components/
COPY static/ ./static/
COPY main.py .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
