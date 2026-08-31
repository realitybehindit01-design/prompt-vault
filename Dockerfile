# PromptVault Pro Production Dockerfile
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PORT=8000

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code and static assets
COPY . .

# Generate mobile APK bundle inside container
RUN python apk_builder.py

EXPOSE 8000

# Start Production Server
CMD ["python", "server.py"]
