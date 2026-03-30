FROM python:3.12-slim

WORKDIR /app

EXPOSE 3000

CMD ["python3", "server.py"]
