# Tor for the wallet's connection to lightwalletd: the server's address stays
# hidden from lightwalletd's operator. Built locally from Alpine's package.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache tor
COPY torrc /etc/tor/torrc
USER tor
EXPOSE 9050
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s \
  CMD nc -z 127.0.0.1 9050 || exit 1
CMD ["tor", "-f", "/etc/tor/torrc"]
