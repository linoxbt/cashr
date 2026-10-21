FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home wallet && mkdir -p /data && chown wallet /data
COPY --from=build /src/target/release/unlisted-wallet /usr/local/bin/unlisted-wallet
USER wallet
ENV UW_DATA_DIR=/data UW_LISTEN=0.0.0.0:8232
VOLUME /data
EXPOSE 8232
CMD ["unlisted-wallet"]
