# Pinned by digest: a moved tag must not silently change what builds the wallet.
FROM rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home wallet && mkdir -p /data && chown wallet /data
COPY --from=build /src/target/release/cashr-wallet /usr/local/bin/cashr-wallet
USER wallet
ENV CASHR_WALLET_DATA_DIR=/data CASHR_WALLET_LISTEN=0.0.0.0:8232
VOLUME /data
EXPOSE 8232
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8232' || exit 1
CMD ["cashr-wallet"]
