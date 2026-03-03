FROM cloudflare/sandbox:0.7.8

RUN apt-get update && \
    apt-get install -y \
        python3 \
        python3-pip \
        python3-venv \
        build-essential && \
    pip3 install --no-cache-dir pandas numpy openpyxl requests dbt-core dbt-duckdb duckdb && \
    apt-get clean