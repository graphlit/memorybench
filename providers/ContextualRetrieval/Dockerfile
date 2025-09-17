FROM postgres:16

# Install build dependencies
RUN apt-get update && \
    apt-get install -y git build-essential postgresql-server-dev-16 && \
    rm -rf /var/lib/apt/lists/*

# Clone and build pgvector
RUN git clone --branch v0.7.0 https://github.com/pgvector/pgvector.git /pgvector && \
    cd /pgvector && \
    make && \
    make install

# Clean up
RUN rm -rf /pgvector

# Expose default Postgres port
EXPOSE 5432
