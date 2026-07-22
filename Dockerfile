FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY static ./static
RUN useradd -r -u 999 carcosts && mkdir -p /srv/data && chown carcosts /srv/data
USER carcosts
VOLUME /srv/data
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
