FROM python:3.12-slim

WORKDIR /app

COPY server.py .
COPY public/ public/

EXPOSE 3000

CMD ["python3", "server.py"]
